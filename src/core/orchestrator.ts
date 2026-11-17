/**
 * FORGE orchestration contracts.
 *
 * The engine coordinates provider-generated text proposals only. It has no
 * shell, filesystem-write, network, or tool-execution capability.
 */

export type TaskStatus =
  | "pending"
  | "awaiting_approval"
  | "running"
  | "completed"
  | "failed"
  | "blocked";

export interface AgentTask {
  id: string;
  agent: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
  requiresApproval?: boolean;
}

export interface AgentResponse {
  content: string;
  provider: string;
  model?: string;
}

export interface AgentRequest {
  task: AgentTask;
  completedDependencies: ReadonlyArray<{ id: string; fromAgent?: string; taskTitle?: string; result: string }>;
  projectContext?: string;
}

export interface AgentProvider {
  readonly name: string;
  complete(request: AgentRequest): Promise<AgentResponse>;
}

export interface TaskRecord {
  task: AgentTask;
  status: TaskStatus;
  result?: AgentResponse;
  error?: string;
  approval?: { decision: "approved" | "rejected"; reviewer: string; reason?: string; at: string };
}

export interface RunRecord {
  id: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
  tasks: TaskRecord[];
  /** Cumulative estimated provider token usage persisted with run state. */
  tokenUsage?: { estimatedTokensUsed: number; estimatedTokensByAgent: Record<string, number> };
  events: Array<{
    at: string;
    taskId: string;
    type: "approval_required" | "approved" | "rejected" | "started" | "completed" | "failed" | "blocked" | "budget_exceeded";
    message: string;
  }>;
}

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

function validatePlan(tasks: readonly AgentTask[]): void {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task.id.trim() || !task.agent.trim() || !task.title.trim() || !task.prompt.trim()) {
      throw new PlanValidationError("Every task needs a non-empty id, agent, title, and prompt.");
    }
    if (ids.has(task.id)) throw new PlanValidationError(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new PlanValidationError(`Task "${task.id}" depends on unknown task "${dependency}".`);
      }
      if (dependency === task.id) {
        throw new PlanValidationError(`Task "${task.id}" cannot depend on itself.`);
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new PlanValidationError("Task dependencies contain a cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createRun(goal: string, tasks: readonly AgentTask[]): RunRecord {
  if (!goal.trim()) throw new PlanValidationError("A run goal is required.");
  if (tasks.length === 0) throw new PlanValidationError("A run needs at least one task.");
  validatePlan(tasks);

  const now = timestamp();
  return {
    id: `forge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    goal,
    createdAt: now,
    updatedAt: now,
    status: "pending",
    tasks: tasks.map(task => ({
      task: { ...task, dependsOn: [...(task.dependsOn ?? [])] },
      status: "pending",
    })),
    events: [],
  };
}

/**
 * Advances all currently runnable tasks in plan order.
 * Approval is an explicit, per-task input; no task can execute tools.
 */
export interface AdvanceRunOptions {
  /** Maximum number of independent agents to call at the same time. */
  maxConcurrency?: number;
  projectContext?: string;
  projectContextForTask?: (task: AgentTask) => string | Promise<string>;
  onUpdate?: (run: RunRecord) => void | Promise<void>;
  /** Persist a settled task before waiting for the rest of its parallel batch. */
  onTaskSettled?: (run: RunRecord, taskId: string) => void | Promise<void>;
  shouldCancel?: () => boolean | Promise<boolean>;
}

/**
 * Runs dependency-ready tasks in bounded parallel batches.
 * Results are committed to the in-memory run only after each batch settles,
 * preventing concurrent agents from observing partially updated sibling results.
 */
export async function advanceRun(
  run: RunRecord,
  provider: AgentProvider,
  approvedTaskIds: ReadonlySet<string> = new Set(),
  options: AdvanceRunOptions = {},
): Promise<RunRecord> {
  const requestedConcurrency = options.maxConcurrency ?? 4;
  if (!Number.isSafeInteger(requestedConcurrency) || requestedConcurrency < 1 || requestedConcurrency > 16) {
    throw new PlanValidationError("Maximum agent concurrency must be an integer between 1 and 16.");
  }
  const maxConcurrency = requestedConcurrency;
  const next: RunRecord = {
    ...run,
    tasks: run.tasks.map(record => ({ ...record })),
    events: [...run.events],
    updatedAt: timestamp(),
  };
  const records = new Map(next.tasks.map(record => [record.task.id, record]));
  const previous = new Map(run.tasks.map(record => [record.task.id, record]));
  const appendEvent = (taskId: string, type: RunRecord["events"][number]["type"], message: string) => {
    next.events.push({ at: timestamp(), taskId, type, message });
  };

  // Keep processing newly unblocked dependency layers until no task can start.
  while (true) {
    if (await options.shouldCancel?.()) {
      next.status = "cancelled"; next.updatedAt = timestamp();
      appendEvent("*", "blocked", "Cancellation requested; no further tasks will be started.");
      await options.onUpdate?.(next);
      break;
    }
    let changed = false;

    for (const record of next.tasks) {
      if (record.status === "completed" || record.status === "failed" || record.status === "blocked") continue;
      const dependencies = (record.task.dependsOn ?? []).map(id => records.get(id)!);
      if (dependencies.some(dependency => dependency.status === "failed" || dependency.status === "blocked")) {
        record.status = "blocked";
        appendEvent(record.task.id, "blocked", "A required dependency did not complete.");
        changed = true;
      }
    }

    const ready = next.tasks.filter(record => {
      if (record.status === "completed" || record.status === "failed" || record.status === "blocked") return false;
      const dependencies = (record.task.dependsOn ?? []).map(id => records.get(id)!);
      return dependencies.every(dependency => dependency.status === "completed");
    });

    const approved: TaskRecord[] = [];
    for (const record of ready) {
      if (record.task.requiresApproval && record.approval?.decision !== "approved" && !approvedTaskIds.has(record.task.id)) {
        record.status = "awaiting_approval";
        if (previous.get(record.task.id)?.status !== "awaiting_approval") {
          appendEvent(record.task.id, "approval_required", "Explicit approval is required before this task can be sent to the provider.");
        }
      } else {
        approved.push(record);
      }
    }

    if (approved.length === 0) {
      if (!changed) break;
      continue;
    }

    const batch = approved.slice(0, maxConcurrency);
    for (const record of batch) { record.status = "running"; appendEvent(record.task.id, "started", `Sent to provider "${provider.name}".`); }
    next.status = "running"; next.updatedAt = timestamp();
    await options.onUpdate?.(next);
    let settlementQueue = Promise.resolve();
    const persistSettledTask = (record: TaskRecord): Promise<void> => {
      if (!options.onTaskSettled) return Promise.resolve();
      const snapshot: RunRecord = {
        ...next,
        tasks: next.tasks.map(item => ({ ...item })),
        events: [...next.events],
        updatedAt: timestamp(),
      };
      settlementQueue = settlementQueue.then(() => options.onTaskSettled!(snapshot, record.task.id));
      return settlementQueue;
    };
    const batchResults = await Promise.all(batch.map(async record => {
      const dependencies = (record.task.dependsOn ?? []).map(id => records.get(id)!);
      let outcome: { record: TaskRecord; result: AgentResponse } | { record: TaskRecord; error: string };
      try {
        const taskSpecificContext = await options.projectContextForTask?.(record.task);
        const projectContext = [options.projectContext, taskSpecificContext].filter(Boolean).join("\n\n");
        const result = await provider.complete({
          task: record.task,
          completedDependencies: dependencies.map(dependency => ({
            id: dependency.task.id,
            fromAgent: dependency.task.agent,
            taskTitle: dependency.task.title,
            result: dependency.result?.content ?? "",
          })),
          ...(projectContext ? { projectContext } : {}),
        });
        if (!result || typeof result.content !== "string" || !result.content.trim() ||
            typeof result.provider !== "string" || !result.provider.trim() ||
            (result.model !== undefined && typeof result.model !== "string")) {
          throw new Error("Provider returned an invalid or empty agent proposal.");
        }
        outcome = { record, result };
      } catch (error) {
        outcome = { record, error: error instanceof Error ? error.message : String(error) };
      }
      if ("result" in outcome) {
        record.result = outcome.result;
        record.status = "completed";
        appendEvent(record.task.id, "completed", "Provider returned a proposal.");
      } else {
        record.status = "failed";
        record.error = outcome.error;
        appendEvent(record.task.id, "failed", outcome.error);
      }
      await persistSettledTask(record);
      return outcome;
    }));
    const budgetExceeded = batchResults.some(outcome => "error" in outcome && outcome.error.startsWith("FORGE budget exceeded:"));
    if (budgetExceeded) {
      for (const record of next.tasks) {
        if (record.status === "pending" || record.status === "awaiting_approval") {
          record.status = "blocked";
          record.error = "Not started because the run budget was exceeded.";
          appendEvent(record.task.id, "blocked", record.error);
        }
      }
      next.status = "failed";
      next.updatedAt = timestamp();
      appendEvent("*", "budget_exceeded", "A configured token budget was exceeded; no additional tasks will be started.");
      await options.onUpdate?.(next);
      break;
    }
    if (await options.shouldCancel?.()) {
      next.status = "cancelled"; next.updatedAt = timestamp();
      appendEvent("*", "blocked", "Cancellation requested; the active batch has finished and no further tasks will be started.");
    } else {
      next.status = "running"; next.updatedAt = timestamp();
    }
    await options.onUpdate?.(next);
    if (next.status === "cancelled") break;
  }

  if (next.status === "cancelled") { await options.onUpdate?.(next); return next; }
  const statuses = next.tasks.map(record => record.status);
  if (statuses.every(status => status === "completed")) next.status = "completed";
  else if (statuses.some(status => status === "failed" || status === "blocked")) next.status = "failed";
  else if (statuses.some(status => status === "awaiting_approval")) next.status = "awaiting_approval";
  else if (statuses.some(status => status === "running")) next.status = "running";
  else next.status = "pending";
  next.updatedAt = timestamp();
  await options.onUpdate?.(next);

  return next;
}

/** Deterministic provider for tests, demos, and offline integration checks. */
export class DemoAgentProvider implements AgentProvider {
  readonly name = "forge-demo";

  async complete(request: AgentRequest): Promise<AgentResponse> {
    return {
      provider: this.name,
      model: "deterministic-demo",
      content: [
        `Proposal from ${request.task.agent}: ${request.task.title}`,
        request.task.prompt,
        request.completedDependencies.length
          ? `Completed context: ${request.completedDependencies.map(item => item.id).join(", ")}`
          : "No completed task dependencies.",
        "This is a demonstration proposal, not an executed code change.",
      ].join("\n\n"),
    };
  }
}
