import { createRun, type RunRecord } from "./orchestrator.js";

/**
 * Creates a new, auditable replay run from a failed run.
 * Completed prerequisites are retained; provider/policy-blocked tasks are not
 * silently reset. The caller must explicitly resume the returned run.
 */
export function createReplayRun(source: RunRecord): RunRecord {
  const rejected = source.tasks.find(record => record.approval?.decision === "rejected");
  if (rejected) throw new Error(`Cannot replay run: task "${rejected.task.id}" was explicitly rejected.`);
  const retryable = source.tasks.filter(record =>
    record.status === "failed" ||
    (record.status === "blocked" && !record.error?.startsWith("Blocked by policy hook:")),
  );
  if (retryable.length === 0) throw new Error("This run has no retryable failed or dependency-blocked tasks.");
  const replay = createRun(source.goal, source.tasks.map(record => record.task));
  replay.tasks = source.tasks.map(record => {
    const shouldReset = record.status === "failed" ||
      (record.status === "blocked" && !record.error?.startsWith("Blocked by policy hook:"));
    return shouldReset
      ? { task: { ...record.task, dependsOn: [...(record.task.dependsOn ?? [])] }, status: "pending" as const }
      : { ...record, task: { ...record.task, dependsOn: [...(record.task.dependsOn ?? [])] } };
  });
  replay.events.push({
    at: new Date().toISOString(),
    taskId: "*",
    type: "started",
    message: `Replay created from run ${source.id}; completed task results were retained.`,
  });
  return replay;
}

/** Creates a focused retry run for one failed task and its blocked dependants. */
export function createTaskRetryRun(source: RunRecord, taskId: string): RunRecord {
  const target = source.tasks.find(record => record.task.id === taskId);
  if (!target || target.status !== "failed") {
    throw new Error("Only a failed task can be retried directly; retry its failed prerequisite instead.");
  }
  if (target.approval?.decision === "rejected") {
    throw new Error("An explicitly rejected task cannot be retried.");
  }
  const reset = new Set<string>([taskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of source.tasks) {
      if (!reset.has(record.task.id) && record.status === "blocked" &&
          (record.task.dependsOn ?? []).some(dependency => reset.has(dependency)) &&
          !record.error?.startsWith("Blocked by policy hook:")) {
        reset.add(record.task.id); changed = true;
      }
    }
  }
  const retry = createRun(source.goal, source.tasks.map(record => record.task));
  retry.tasks = source.tasks.map(record => reset.has(record.task.id)
    ? { task: { ...record.task, dependsOn: [...(record.task.dependsOn ?? [])] }, status: "pending" as const }
    : { ...record, task: { ...record.task, dependsOn: [...(record.task.dependsOn ?? [])] } });
  retry.events.push({
    at: new Date().toISOString(), taskId,
    type: "started",
    message: `Focused retry created from run ${source.id}; reset ${[...reset].join(", ")}.`,
  });
  return retry;
}
