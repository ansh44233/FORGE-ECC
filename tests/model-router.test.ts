import { describe, expect, it } from "vitest";
import { chooseModelRoute, ModelRouter } from "../src/core/model-router.js";
import type { AgentProvider } from "../src/core/orchestrator.js";

const models = { fastModel: "small-model", balancedModel: "mid-model", reasoningModel: "large-model" };

describe("restored token budgets", () => {
  it("applies previously persisted run and agent usage before any provider call", async () => {
    let providerCalls = 0;
    const router = new ModelRouter({
      ...models,
      maxEstimatedTokensPerRun: 10,
      maxEstimatedTokensPerAgent: { "documentation-writer": 10 },
      initialEstimatedTokensUsed: 8,
      initialEstimatedTokensByAgent: { "documentation-writer": 8 },
      createProvider: model => ({
        name: model,
        async complete() {
          providerCalls += 1;
          return { provider: model, model, content: "proposal" };
        },
      }),
    });
    await expect(router.complete({
      task: { id: "resume-task", agent: "documentation-writer", title: "Docs", prompt: "Write docs" },
      completedDependencies: [],
    })).rejects.toThrow("before provider call");
    expect(providerCalls).toBe(0);
    expect(router.traces[0]?.provider).toBe("not-started");
  });
});

describe("task-aware model routing", () => {
  it("routes security and architecture work to reasoning tier", () => {
    expect(chooseModelRoute({ task: { id: "1", agent: "security-reviewer", title: "Review", prompt: "Review" }, completedDependencies: [] }, models).tier).toBe("reasoning");
    expect(chooseModelRoute({ task: { id: "2", agent: "architect", title: "Design", prompt: "Design" }, completedDependencies: [] }, models).model).toBe("large-model");
  });
  it("routes focused documentation work to fast tier", () => {
    expect(chooseModelRoute({ task: { id: "1", agent: "documentation-writer", title: "Docs", prompt: "Update guide" }, completedDependencies: [] }, models).model).toBe("small-model");
  });
  it("retries transient provider failures with bounded exponential backoff", async () => {
    let calls = 0;
    const delays: number[] = [];
    const router = new ModelRouter({
      ...models,
      retryAttempts: 2,
      retryDelayMs: 25,
      sleep: async milliseconds => { delays.push(milliseconds); },
      createProvider: model => ({
        name: model,
        async complete() {
          calls += 1;
          if (calls < 3) throw new Error("AI provider request failed with HTTP 429.");
          return { provider: model, model, content: "recovered proposal" };
        },
      }),
    });
    const result = await router.complete({ task: { id: "docs", agent: "documentation-writer", title: "Docs", prompt: "Write docs" }, completedDependencies: [] });
    expect(result.content).toBe("recovered proposal");
    expect(calls).toBe(3);
    expect(delays).toEqual([25, 50]);
    expect(router.traces[0]?.retries).toBe(2);
    expect(router.traces[0]?.outcome).toBe("success");
  });

  it("does not retry non-rate-limit provider errors, including ambiguous server failures", async () => {
    let calls = 0;
    const router = new ModelRouter({
      ...models,
      retryAttempts: 3,
      createProvider: model => ({
        name: model,
        async complete() { calls += 1; throw new Error("AI provider request failed with HTTP 503."); },
      }),
    });
    await expect(router.complete({ task: { id: "docs", agent: "documentation-writer", title: "Docs", prompt: "Write docs" }, completedDependencies: [] })).rejects.toThrow("HTTP 503");
    expect(calls).toBe(1);
    expect(router.traces[0]?.retries).toBe(0);
  });

  it("records provider factory failures before any provider call", async () => {
    const observed: string[] = [];
    const router = new ModelRouter({
      ...models,
      onTrace(trace) { observed.push(trace.outcome); },
      createProvider() { throw new Error("provider configuration unavailable"); },
    });
    await expect(router.complete({ task: { id: "factory", agent: "planner", title: "Factory", prompt: "Try" }, completedDependencies: [] })).rejects.toThrow("provider configuration unavailable");
    expect(router.traces).toHaveLength(1);
    expect(router.traces[0]).toMatchObject({ taskId: "factory", outcome: "failed", provider: "unavailable", outputTokensEstimate: 0 });
    expect(observed).toEqual(["failed"]);
  });

  it("does not consume token budget when provider initialization fails", async () => {
    let factories = 0;
    const router = new ModelRouter({
      ...models,
      maxEstimatedTokensPerRun: 5,
      createProvider: model => {
        factories += 1;
        if (factories === 1) throw new Error("provider setup failed");
        return {
          name: model,
          async complete() { return { provider: model, content: "ok" }; },
        };
      },
    });
    await expect(router.complete({ task: { id: "setup", agent: "planner", title: "Setup", prompt: "x" }, completedDependencies: [] })).rejects.toThrow("provider setup failed");
    const result = await router.complete({ task: { id: "next", agent: "planner", title: "Next", prompt: "x" }, completedDependencies: [] });
    expect(result.content).toBe("ok");
    expect(router.traces.map(trace => trace.outcome)).toEqual(["failed", "success"]);
  });

  it("keeps a successful provider result when the trace observer throws", async () => {
    const router = new ModelRouter({
      ...models,
      onTrace() { throw new Error("telemetry unavailable"); },
      createProvider: model => ({
        name: model,
        async complete() { return { provider: model, content: "valid proposal" }; },
      }),
    });
    const result = await router.complete({ task: { id: "trace", agent: "planner", title: "Trace", prompt: "Write" }, completedDependencies: [] });
    expect(result.content).toBe("valid proposal");
    expect(router.traces[0]?.outcome).toBe("success");
  });

  it("sends failed provider outcomes to the trace observer", async () => {
    const observed: string[] = [];
    const router = new ModelRouter({
      ...models,
      onTrace(trace) { observed.push(trace.outcome); },
      createProvider: model => ({
        name: model,
        async complete() { throw new Error("AI provider request failed with HTTP 503."); },
      }),
    });
    await expect(router.complete({ task: { id: "failed", agent: "planner", title: "Failure", prompt: "Try" }, completedDependencies: [] })).rejects.toThrow("HTTP 503");
    expect(observed).toEqual(["failed"]);
  });

  it("records preflight budget rejections without calling the provider", async () => {
    const observed: string[] = [];
    let calls = 0;
    const router = new ModelRouter({
      ...models,
      maxInputTokensPerTask: 2,
      onTrace(trace) { observed.push(trace.outcome); },
      createProvider: model => ({
        name: model,
        async complete() { calls += 1; return { provider: model, content: "unused" }; },
      }),
    });
    await expect(router.complete({ task: { id: "large", agent: "planner", title: "Large", prompt: "This prompt is deliberately too large" }, completedDependencies: [] })).rejects.toThrow("FORGE budget exceeded");
    expect(calls).toBe(0);
    expect(router.traces).toHaveLength(1);
    expect(router.traces[0]).toMatchObject({ taskId: "large", outcome: "failed", provider: "not-started", outputTokensEstimate: 0 });
    expect(observed).toEqual(["failed"]);
  });

  it("rejects malformed provider responses and records a failed trace", async () => {
    const observed: string[] = [];
    const router = new ModelRouter({
      ...models,
      fallbackModel: "backup-model",
      onTrace(trace) { observed.push(trace.outcome); },
      createProvider: model => ({
        name: model,
        async complete() { return { provider: model, content: "" }; },
      }),
    });
    await expect(router.complete({ task: { id: "malformed", agent: "planner", title: "Malformed", prompt: "Try" }, completedDependencies: [] })).rejects.toThrow("invalid or empty agent proposal");
    expect(router.traces).toHaveLength(1);
    expect(router.traces[0]).toMatchObject({ taskId: "malformed", outcome: "failed", outputTokensEstimate: 0 });
    expect(observed).toEqual(["failed"]);
  });

  it("rejects an oversized task input before calling the provider", async () => {
    let calls = 0;
    const router = new ModelRouter({
      ...models,
      maxInputTokensPerTask: 2,
      createProvider: model => ({
        name: model,
        async complete() { calls += 1; return { provider: model, content: "no" }; },
      }),
    });
    await expect(router.complete({ task: { id: "large", agent: "planner", title: "Large", prompt: "This prompt is deliberately too large" }, completedDependencies: [] })).rejects.toThrow("FORGE budget exceeded");
    expect(calls).toBe(0);
  });

  it("rejects provider output that exceeds the per-task output budget", async () => {
    const router = new ModelRouter({
      ...models,
      maxOutputTokensPerTask: 2,
      createProvider: model => ({
        name: model,
        async complete() { return { provider: model, content: "This output is too large for the configured limit." }; },
      }),
    });
    await expect(router.complete({ task: { id: "large", agent: "planner", title: "Large", prompt: "Small prompt" }, completedDependencies: [] })).rejects.toThrow("output estimate");
    expect(router.traces[0]?.outcome).toBe("failed");
  });

  it("counts provider output even when the per-task output limit rejects it", async () => {
    let calls = 0;
    const router = new ModelRouter({
      ...models,
      maxOutputTokensPerTask: 2,
      maxEstimatedTokensPerRun: 15,
      createProvider: model => ({
        name: model,
        async complete() {
          calls += 1;
          return { provider: model, content: "This output is too large for the configured limit." };
        },
      }),
    });
    const request = { task: { id: "large-output", agent: "planner", title: "Large output", prompt: "Small prompt" }, completedDependencies: [] };
    await expect(router.complete(request)).rejects.toThrow("output estimate");
    await expect(router.complete({ ...request, task: { ...request.task, id: "next" } })).rejects.toThrow("run estimate");
    expect(calls).toBe(1);
    expect(router.traces.map(trace => trace.outcome)).toEqual(["failed", "failed"]);
  });

  it("enforces a run-wide estimated token budget across tasks", async () => {
    let calls = 0;
    const router = new ModelRouter({
      ...models,
      maxEstimatedTokensPerRun: 8,
      createProvider: model => ({
        name: model,
        async complete() { calls += 1; return { provider: model, content: "A short response." }; },
      }),
    });
    const request = { task: { id: "one", agent: "planner", title: "One", prompt: "Short" }, completedDependencies: [] };
    await router.complete(request);
    await expect(router.complete({ ...request, task: { ...request.task, id: "two" } })).rejects.toThrow("run estimate would exceed");
    expect(calls).toBe(1);
  });



  it("enforces a cumulative estimated token budget per agent", async () => {
    let calls = 0;
    const router = new ModelRouter({ ...models, maxEstimatedTokensPerAgent: { planner: 4 }, createProvider: model => ({ name: model, async complete() { calls += 1; return { provider: model, content: "tiny" }; } }) });
    const request = { task: { id: "first", agent: "planner", title: "First", prompt: "Short" }, completedDependencies: [] };
    await router.complete(request);
    await expect(router.complete({ ...request, task: { ...request.task, id: "second" } })).rejects.toThrow(/agent planner estimate would exceed/);
    expect(calls).toBe(1);
  });
  it("stops waiting when a task exceeds its duration budget and skips fallback", async () => {
    let primaryCalls = 0; let fallbackCalls = 0;
    const router = new ModelRouter({ ...models, maxTaskDurationMs: 5, fallbackModel: "backup-model", createProvider: model => ({ name: model, async complete() { if (model === "backup-model") fallbackCalls += 1; else primaryCalls += 1; await new Promise(resolve => setTimeout(resolve, 30)); return { provider: model, content: "late response" }; } }) });
    await expect(router.complete({ task: { id: "slow", agent: "planner", title: "Slow", prompt: "Wait" }, completedDependencies: [] })).rejects.toThrow(/duration exceeded 5 ms/);
    expect(primaryCalls).toBe(1); expect(fallbackCalls).toBe(0); expect(router.traces[0]?.outcome).toBe("failed");
  });

  it("includes retry backoff inside the overall task duration budget", async () => {
    let calls = 0;
    const router = new ModelRouter({
      ...models,
      maxTaskDurationMs: 20,
      retryAttempts: 2,
      retryDelayMs: 30,
      createProvider: model => ({
        name: model,
        async complete() {
          calls += 1;
          throw new Error("AI provider request failed with HTTP 429.");
        },
      }),
    });
    await expect(router.complete({ task: { id: "deadline", agent: "planner", title: "Deadline", prompt: "Try" }, completedDependencies: [] })).rejects.toThrow(/duration exceeded 20 ms/);
    expect(calls).toBe(1);
    expect(router.traces[0]?.outcome).toBe("failed");
  });

  it("applies a stricter per-agent duration ceiling", async () => {
    const router = new ModelRouter({ ...models, maxTaskDurationMs: 100, maxTaskDurationMsByAgent: { planner: 5 }, createProvider: model => ({ name: model, async complete() { await new Promise(resolve => setTimeout(resolve, 25)); return { provider: model, content: "late" }; } }) });
    await expect(router.complete({ task: { id: "slow", agent: "planner", title: "Slow", prompt: "Wait" }, completedDependencies: [] })).rejects.toThrow(/duration exceeded 5 ms/);
  });
  it("does not call fallback after an ambiguous server failure", async () => {
    const created: string[] = [];
    const router = new ModelRouter({
      ...models,
      fallbackModel: "backup-model",
      createProvider: model => ({
        name: model,
        async complete() {
          created.push(model);
          throw new Error("AI provider request failed with HTTP 503.");
        },
      }),
    });
    await expect(router.complete({ task: { id: "secure", agent: "security-reviewer", title: "Security review", prompt: "Review auth" }, completedDependencies: [] })).rejects.toThrow("HTTP 503");
    expect(created).toEqual(["large-model"]);
    expect(router.traces[0]?.outcome).toBe("failed");
  });

  it("reserves a separate input budget for fallback requests", async () => {
    const created: string[] = [];
    const router = new ModelRouter({
      ...models,
      fallbackModel: "backup-model",
      maxEstimatedTokensPerRun: 5,
      createProvider: model => ({
        name: model,
        async complete() {
          created.push(model);
          if (model === "large-model") throw new Error("AI provider request failed with HTTP 429.");
          return { provider: model, content: "fallback proposal" };
        },
      }),
    });
    await expect(router.complete({ task: { id: "fallback-budget", agent: "security-reviewer", title: "Review", prompt: "Review auth" }, completedDependencies: [] })).rejects.toThrow("before fallback provider call");
    expect(created.length).toBeGreaterThan(0);
    expect(created.every(model => model === "large-model")).toBe(true);
    expect(router.traces[0]?.outcome).toBe("failed");
    expect(router.traces[0]?.provider).toBe("not-started");
  });

  it("records generated fallback output when a post-response budget rejects it", async () => {
    const router = new ModelRouter({
      ...models,
      fallbackModel: "backup-model",
      maxOutputTokensPerTask: 1,
      createProvider: model => ({
        name: model,
        async complete() {
          if (model === "large-model") throw new Error("AI provider request failed with HTTP 429.");
          return { provider: model, content: "This fallback output exceeds the configured limit." };
        },
      }),
    });
    await expect(router.complete({ task: { id: "fallback-output", agent: "security-reviewer", title: "Review", prompt: "Review auth" }, completedDependencies: [] })).rejects.toThrow("fallback output estimate");
    expect(router.traces[0]).toMatchObject({ outcome: "failed", provider: "backup-model" });
    expect(router.traces[0]?.outputTokensEstimate).toBeGreaterThan(1);
  });

  it("uses configured fallback and records a trace", async () => {
    const created: string[] = [];
    const createProvider = (model: string): AgentProvider => {
      created.push(model);
      return {
        name: model,
        async complete() {
          if (model === "large-model") throw new Error("AI provider request failed with HTTP 429.");
          return { provider: model, model, content: "fallback proposal" };
        },
      };
    };
    const router = new ModelRouter({ ...models, fallbackModel: "backup-model", createProvider });
    const result = await router.complete({ task: { id: "secure", agent: "security-reviewer", title: "Security review", prompt: "Review auth" }, completedDependencies: [] });
    expect(result.model).toBe("backup-model");
    expect(created).toEqual(["large-model", "backup-model"]);
    expect(router.traces[0]?.outcome).toBe("fallback");
    expect(router.traces[0]?.inputTokensEstimate).toBeGreaterThan(0);
  });
});

describe("concurrent cumulative token budgets", () => {
  it("serializes budgeted provider calls so parallel outputs cannot overrun the run ceiling", async () => {
    let providerCalls = 0;
    const router = new ModelRouter({
      ...models,
      maxEstimatedTokensPerRun: 11,
      createProvider: model => ({
        name: model,
        async complete() {
          providerCalls += 1;
          return { provider: model, content: "x".repeat(40) };
        },
      }),
    });
    const request = (id: string) => ({
      task: { id, agent: "planner", title: id, prompt: "x" },
      completedDependencies: [],
    });

    const outcomes = await Promise.allSettled([
      router.complete(request("parallel-one")),
      router.complete(request("parallel-two")),
    ]);

    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(providerCalls).toBe(1);
    expect(router.traces.map(trace => trace.provider)).toContain("not-started");
  });
});
