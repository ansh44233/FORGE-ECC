import type { AgentProvider, AgentRequest, AgentResponse } from "./orchestrator.js";

export type ModelTier = "fast" | "balanced" | "reasoning";
export interface ModelRoute { tier: ModelTier; model: string; reason: string; }
export interface AgentTrace {
  taskId: string;
  agent: string;
  tier: ModelTier;
  model: string;
  provider: string;
  startedAt: string;
  durationMs: number;
  outcome: "success" | "fallback" | "failed";
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  error?: string;
  retries?: number;
}
export interface ModelRouterOptions {
  fastModel: string;
  balancedModel: string;
  reasoningModel: string;
  fallbackModel?: string;
  createProvider: (model: string) => AgentProvider;
  onTrace?: (trace: AgentTrace) => void;
  retryAttempts?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  maxInputTokensPerTask?: number;
  maxOutputTokensPerTask?: number;
  maxEstimatedTokensPerRun?: number;
  /** Previously accounted usage restored when continuing a persisted run. */
  initialEstimatedTokensUsed?: number;
  /** Previously accounted usage by agent, restored when continuing a persisted run. */
  initialEstimatedTokensByAgent?: Readonly<Record<string, number>>;
  /** Optional cumulative estimated input + output token ceilings keyed by agent ID. */
  maxEstimatedTokensPerAgent?: Readonly<Record<string, number>>;
  /** Wall-clock ceiling; providers without abort support may continue after FORGE stops waiting. */
  maxTaskDurationMs?: number;
  /** Optional stricter duration ceilings keyed by agent ID. */
  maxTaskDurationMsByAgent?: Readonly<Record<string, number>>;
}

export function chooseModelRoute(request: AgentRequest, models: Pick<ModelRouterOptions, "fastModel" | "balancedModel" | "reasoningModel">): ModelRoute {
  const agent = request.task.agent.toLowerCase();
  const text = (request.task.title + " " + request.task.prompt).toLowerCase();
  const highStakes = /security|debugger|architect|release-manager/.test(agent)
    || /security|vulnerability|architecture|migration|root cause|incident|critical/.test(text);
  const simple = /documentation-writer|accessibility-reviewer/.test(agent)
    || /typo|format|rename|readme|document/.test(text);
  if (highStakes) return { tier: "reasoning", model: models.reasoningModel, reason: "High-impact reasoning or specialist role." };
  if (simple) return { tier: "fast", model: models.fastModel, reason: "Focused, lower-complexity task." };
  return { tier: "balanced", model: models.balancedModel, reason: "General engineering task." };
}


function validateProviderResponse(value: unknown): AgentResponse {
  if (!value || typeof value !== "object") throw new Error("Provider returned an invalid agent proposal.");
  const response = value as Partial<AgentResponse>;
  if (typeof response.content !== "string" || !response.content.trim() ||
      typeof response.provider !== "string" || !response.provider.trim() ||
      (response.model !== undefined && typeof response.model !== "string")) {
    throw new Error("Provider returned an invalid or empty agent proposal.");
  }
  return response as AgentResponse;
}

function isRetryableProviderError(error: unknown): boolean {
  // Retry only an explicit rate-limit response. A timeout, connection loss, or
  // server error can happen after the provider accepted and billed the request;
  // replaying it automatically could duplicate paid generation work.
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 429\b/i.test(message);
}

export class ModelRouter implements AgentProvider {
  readonly name = "forge-model-router";
  readonly traces: AgentTrace[] = [];
  private estimatedTokensUsed = 0;
  private readonly estimatedTokensByAgent = new Map<string, number>();
  private completionQueue: Promise<void> = Promise.resolve();
  private readonly serializeBudgetedCalls: boolean;
  constructor(private readonly options: ModelRouterOptions) {
    this.serializeBudgetedCalls = options.maxEstimatedTokensPerRun !== undefined || options.maxEstimatedTokensPerAgent !== undefined;
    if (!Number.isInteger(options.retryAttempts ?? 2) || (options.retryAttempts ?? 2) < 0 || (options.retryAttempts ?? 2) > 5) throw new Error("Provider retry attempts must be between 0 and 5.");
    if (!Number.isInteger(options.retryDelayMs ?? 500) || (options.retryDelayMs ?? 500) < 0 || (options.retryDelayMs ?? 500) > 10000) throw new Error("Provider retry delay must be between 0 and 10000 milliseconds.");
    for (const [name, value] of Object.entries({ maxInputTokensPerTask: options.maxInputTokensPerTask, maxOutputTokensPerTask: options.maxOutputTokensPerTask, maxEstimatedTokensPerRun: options.maxEstimatedTokensPerRun, maxTaskDurationMs: options.maxTaskDurationMs })) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${name} must be a positive safe integer.`);
    }
    if (options.initialEstimatedTokensUsed !== undefined && (!Number.isSafeInteger(options.initialEstimatedTokensUsed) || options.initialEstimatedTokensUsed < 0)) throw new Error("initialEstimatedTokensUsed must be a non-negative safe integer.");
    this.estimatedTokensUsed = options.initialEstimatedTokensUsed ?? 0;
    for (const [agent, used] of Object.entries(options.initialEstimatedTokensByAgent ?? {})) {
      if (!agent.trim() || !Number.isSafeInteger(used) || used < 0) throw new Error(`Initial token usage for agent ${agent || "<empty>"} must be a non-negative safe integer.`);
      this.estimatedTokensByAgent.set(agent, used);
    }
    for (const [agent, limit] of Object.entries(options.maxEstimatedTokensPerAgent ?? {})) {
      if (!agent.trim() || !Number.isSafeInteger(limit) || limit < 1) throw new Error(`Token budget for agent ${agent || "<empty>"} must be a positive safe integer.`);
    }
    for (const [agent, limit] of Object.entries(options.maxTaskDurationMsByAgent ?? {})) {
      if (!agent.trim() || !Number.isSafeInteger(limit) || limit < 1) throw new Error(`Duration budget for agent ${agent || "<empty>"} must be a positive safe integer.`);
    }
    for (const model of [options.fastModel, options.balancedModel, options.reasoningModel]) {
      if (!model.trim()) throw new Error("Every model routing tier needs a model name.");
    }
  }

  private recordTrace(trace: AgentTrace): void {
    this.traces.push(trace);
    // Observability hooks must not turn a completed provider call into a failed task.
    try { this.options.onTrace?.(trace); } catch { /* Keep execution independent of telemetry consumers. */ }
  }

  complete(request: AgentRequest): Promise<AgentResponse> {
    if (!this.serializeBudgetedCalls) return this.completeTask(request);
    // With cumulative budgets, provider calls must settle one at a time so an
    // earlier response's output estimate is charged before the next preflight.
    const result = this.completionQueue.then(() => this.completeTask(request));
    this.completionQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async completeTask(request: AgentRequest): Promise<AgentResponse> {
    const route = chooseModelRoute(request, this.options);
    const startedAt = new Date().toISOString();
    const start = Date.now();
    const inputText = request.task.prompt + (request.projectContext ?? "") + request.completedDependencies.map(item => item.result).join("");
    const inputTokensEstimate = Math.ceil(inputText.length / 4);
    const rejectBeforeProvider = (message: string): never => {
      this.recordTrace({
        taskId: request.task.id, agent: request.task.agent, tier: route.tier,
        model: route.model, provider: "not-started", startedAt,
        durationMs: Date.now() - start, outcome: "failed", retries: 0,
        inputTokensEstimate, outputTokensEstimate: 0, error: message,
      });
      throw new Error(message);
    };
    const maxInput = this.options.maxInputTokensPerTask;
    if (maxInput !== undefined && inputTokensEstimate > maxInput) rejectBeforeProvider(`FORGE budget exceeded: task input estimate ${inputTokensEstimate} exceeds per-task limit ${maxInput}.`);
    const runLimit = this.options.maxEstimatedTokensPerRun;
    const agentLimit = this.options.maxEstimatedTokensPerAgent?.[request.task.agent];
    const agentUsed = this.estimatedTokensByAgent.get(request.task.agent) ?? 0;
    const maxOutput = this.options.maxOutputTokensPerTask;
    if (runLimit !== undefined && this.estimatedTokensUsed + inputTokensEstimate > runLimit) rejectBeforeProvider(`FORGE budget exceeded: run estimate would exceed ${runLimit} tokens before provider call.`);
    if (agentLimit !== undefined && agentUsed + inputTokensEstimate > agentLimit) rejectBeforeProvider(`FORGE budget exceeded: agent ${request.task.agent} estimate would exceed ${agentLimit} tokens before provider call.`);
    let provider: AgentProvider;
    try {
      provider = this.options.createProvider(route.model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.recordTrace({
        taskId: request.task.id, agent: request.task.agent, tier: route.tier,
        model: route.model, provider: "unavailable", startedAt,
        durationMs: Date.now() - start, outcome: "failed", retries: 0,
        inputTokensEstimate, outputTokensEstimate: 0, error: message,
      });
      throw error;
    }
    // A provider factory failure happens before any request can be sent, so it
    // must not consume estimated provider-token budget.
    this.estimatedTokensUsed += inputTokensEstimate;
    this.estimatedTokensByAgent.set(request.task.agent, agentUsed + inputTokensEstimate);
    const durationLimit = this.options.maxTaskDurationMsByAgent?.[request.task.agent] ?? this.options.maxTaskDurationMs;
    const durationError = (): Error => new Error(`FORGE budget exceeded: task duration exceeded ${durationLimit} ms for agent ${request.task.agent}. The provider request may still be running.`);
    const remainingDuration = (): number | undefined => durationLimit === undefined ? undefined : durationLimit - (Date.now() - start);
    const waitWithinBudget = async (milliseconds: number): Promise<void> => {
      const remaining = remainingDuration();
      if (remaining === undefined) { await (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(milliseconds); return; }
      if (remaining <= 0) throw durationError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (this.options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(milliseconds),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(durationError()), remaining); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
      if ((remainingDuration() ?? 1) <= 0) throw durationError();
    };
    const completeWithinBudget = async (target: AgentProvider): Promise<AgentResponse> => {
      const complete = async (): Promise<AgentResponse> => validateProviderResponse(await target.complete(request));
      const remaining = remainingDuration();
      if (remaining === undefined) return complete();
      if (remaining <= 0) throw durationError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          complete(),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(durationError()), remaining); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    };
    let retries = 0;
    let response: AgentResponse | undefined;
    let primaryError: unknown;
    const maxRetries = this.options.retryAttempts ?? 2;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        response = await completeWithinBudget(provider);
        break;
      } catch (error) {
        primaryError = error;
        if (attempt >= maxRetries || !isRetryableProviderError(error)) break;
        retries += 1;
        const delay = (this.options.retryDelayMs ?? 500) * Math.pow(2, attempt);
        try {
          await waitWithinBudget(delay);
        } catch (waitError) {
          primaryError = waitError;
          break;
        }
      }
    }
    if (response) {
      const outputTokensEstimate = Math.ceil(response.content.length / 4);
      // Account for generated output even when policy rejects it: the provider
      // has already produced (and potentially billed) these tokens.
      this.estimatedTokensUsed += outputTokensEstimate;
      this.estimatedTokensByAgent.set(request.task.agent, (this.estimatedTokensByAgent.get(request.task.agent) ?? 0) + outputTokensEstimate);
      if (maxOutput !== undefined && outputTokensEstimate > maxOutput) {
        const message = `FORGE budget exceeded: task output estimate ${outputTokensEstimate} exceeds per-task limit ${maxOutput}.`;
        this.recordTrace({ taskId: request.task.id, agent: request.task.agent, tier: route.tier, model: response.model ?? route.model, provider: response.provider, startedAt, durationMs: Date.now() - start, outcome: "failed", retries, inputTokensEstimate, outputTokensEstimate, error: message });
        throw new Error(message);
      }
      if (agentLimit !== undefined && (this.estimatedTokensByAgent.get(request.task.agent) ?? 0) > agentLimit) {
        const message = `FORGE budget exceeded: agent ${request.task.agent} estimate would exceed ${agentLimit} tokens after provider response.`;
        this.recordTrace({ taskId: request.task.id, agent: request.task.agent, tier: route.tier, model: response.model ?? route.model, provider: response.provider, startedAt, durationMs: Date.now() - start, outcome: "failed", retries, inputTokensEstimate, outputTokensEstimate, error: message });
        throw new Error(message);
      }
      if (runLimit !== undefined && this.estimatedTokensUsed > runLimit) {
        const message = `FORGE budget exceeded: run estimate would exceed ${runLimit} tokens after provider response.`;
        this.recordTrace({ taskId: request.task.id, agent: request.task.agent, tier: route.tier, model: response.model ?? route.model, provider: response.provider, startedAt, durationMs: Date.now() - start, outcome: "failed", retries, inputTokensEstimate, outputTokensEstimate, error: message });
        throw new Error(message);
      }
      const trace: AgentTrace = {
        taskId: request.task.id, agent: request.task.agent, tier: route.tier,
        model: response.model ?? route.model, provider: response.provider,
        startedAt, durationMs: Date.now() - start, outcome: "success", retries,
        inputTokensEstimate,
        outputTokensEstimate,
      };
      this.recordTrace(trace);
      return response;
    }
    try {
      throw primaryError;
    } catch (primaryError) {
      const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
      if (primaryMessage.startsWith("FORGE budget exceeded:") || !isRetryableProviderError(primaryError) || !this.options.fallbackModel || this.options.fallbackModel === route.model) {
        const message = primaryMessage;
        this.recordTrace({ taskId: request.task.id, agent: request.task.agent, tier: route.tier, model: route.model, provider: provider.name, startedAt, durationMs: Date.now() - start, outcome: "failed", retries, inputTokensEstimate: Math.ceil(inputText.length / 4), outputTokensEstimate: 0, error: message });
        throw primaryError;
      }
      let fallbackProviderName = "not-started";
      let fallbackOutputEstimate = 0;
      try {
        const fallbackInputEstimate = Math.ceil(inputText.length / 4);
        if (runLimit !== undefined && this.estimatedTokensUsed + fallbackInputEstimate > runLimit) {
          throw new Error(`FORGE budget exceeded: run estimate would exceed ${runLimit} tokens before fallback provider call.`);
        }
        const currentAgentUsage = this.estimatedTokensByAgent.get(request.task.agent) ?? 0;
        if (agentLimit !== undefined && currentAgentUsage + fallbackInputEstimate > agentLimit) {
          throw new Error(`FORGE budget exceeded: agent ${request.task.agent} estimate would exceed ${agentLimit} tokens before fallback provider call.`);
        }
        const fallback = this.options.createProvider(this.options.fallbackModel);
        fallbackProviderName = fallback.name;
        // A fallback is a distinct provider request and has its own input
        // usage. Reserve it only after provider initialization succeeds.
        this.estimatedTokensUsed += fallbackInputEstimate;
        this.estimatedTokensByAgent.set(request.task.agent, currentAgentUsage + fallbackInputEstimate);
        const response = await completeWithinBudget(fallback);
        fallbackOutputEstimate = Math.ceil(response.content.length / 4);
        // The fallback has already generated this output, including when a
        // post-response budget check rejects returning it to the caller.
        this.estimatedTokensUsed += fallbackOutputEstimate;
        this.estimatedTokensByAgent.set(request.task.agent, (this.estimatedTokensByAgent.get(request.task.agent) ?? 0) + fallbackOutputEstimate);
        if (maxOutput !== undefined && fallbackOutputEstimate > maxOutput) throw new Error(`FORGE budget exceeded: fallback output estimate ${fallbackOutputEstimate} exceeds per-task limit ${maxOutput}.`);
        if (agentLimit !== undefined && (this.estimatedTokensByAgent.get(request.task.agent) ?? 0) > agentLimit) throw new Error(`FORGE budget exceeded: agent ${request.task.agent} estimate would exceed ${agentLimit} tokens after fallback response.`);
        if (runLimit !== undefined && this.estimatedTokensUsed > runLimit) {
          throw new Error(`FORGE budget exceeded: run estimate would exceed ${runLimit} tokens after fallback response.`);
        }
        const trace: AgentTrace = {
          taskId: request.task.id, agent: request.task.agent, tier: route.tier,
          model: response.model ?? this.options.fallbackModel, provider: response.provider,
          startedAt, durationMs: Date.now() - start, outcome: "fallback", retries,
          inputTokensEstimate: Math.ceil(inputText.length / 4),
          outputTokensEstimate: Math.ceil(response.content.length / 4),
          error: "Primary model failed; configured fallback was used.",
        };
        this.recordTrace(trace);
        return response;
      } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        this.recordTrace({ taskId: request.task.id, agent: request.task.agent, tier: route.tier, model: this.options.fallbackModel, provider: fallbackProviderName, startedAt, durationMs: Date.now() - start, outcome: "failed", retries, inputTokensEstimate: Math.ceil(inputText.length / 4), outputTokensEstimate: fallbackOutputEstimate, error: message });
        throw fallbackError;
      }
    }
  }
}
