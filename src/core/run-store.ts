import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { RunRecord } from "./orchestrator.js";

const RUN_ID_PATTERN = /^forge-[a-z0-9-]{1,80}$/;
const MAX_RUN_FILE_BYTES = 5 * 1024 * 1024;

function validateRunId(id: string): void {
  if (!RUN_ID_PATTERN.test(id) || id.includes("..")) {
    throw new Error("Invalid FORGE run identifier.");
  }
}

async function safeRunsDirectory(projectPath: string): Promise<string> {
  const project = await realpath(path.resolve(projectPath));
  let current = project;
  for (const part of [".forge", "runs"]) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Run history storage must not contain symbolic links or non-directory components.");
    }
  }
  return current;
}

async function writeRunUnlocked(projectPath: string, run: RunRecord): Promise<string> {
  validateRunId(run.id);
  const directory = await safeRunsDirectory(projectPath);
  const destination = path.join(directory, `${run.id}.json`);
  const temporary = path.join(directory, `.${run.id}.${randomUUID()}.tmp`);
  const serialized = JSON.stringify(run, null, 2) + "\n";
  if (Buffer.byteLength(serialized, "utf8") > MAX_RUN_FILE_BYTES) {
    throw new Error("Run history record exceeds the maximum file size.");
  }

  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return destination;
}

async function withRunLock<T>(projectPath: string, runId: string, action: () => Promise<T>, lockSuffix = ".lock"): Promise<T> {
  validateRunId(runId);
  const directory = await safeRunsDirectory(projectPath);
  const lock = path.join(directory, `${runId}${lockSuffix}`);
  const ownerFile = path.join(lock, "owner.json");
  const token = randomUUID();
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Run ${runId} is locked by another or interrupted FORGE process. Inspect ${lock}/owner.json; do not remove the lock until you have confirmed its owner is no longer active.`);
    }
    throw error;
  }

  try {
    await writeFile(ownerFile, JSON.stringify({
      token,
      pid: process.pid,
      host: os.hostname(),
      startedAt: new Date().toISOString(),
    }) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    return await action();
  } finally {
    try {
      const owner: unknown = JSON.parse(await readFile(ownerFile, "utf8"));
      if (owner && typeof owner === "object" && "token" in owner && owner.token === token) {
        await rm(lock, { recursive: true, force: true });
      }
    } catch {
      // If ownership cannot be verified, leave the lock in place rather than
      // risk deleting a lock that may have been replaced by another process.
    }
  }
}

/** Holds an exclusive execution lease across a complete resume operation. */
export async function withRunExecutionLock<T>(projectPath: string, runId: string, action: () => Promise<T>): Promise<T> {
  return withRunLock(projectPath, runId, action, ".execution.lock");
}

export async function saveRun(projectPath: string, run: RunRecord): Promise<string> {
  return withRunLock(projectPath, run.id, () => writeRunUnlocked(projectPath, run));
}

export async function loadRun(projectPath: string, runId: string): Promise<RunRecord> {
  validateRunId(runId);
  const filePath = path.join(await safeRunsDirectory(projectPath), `${runId}.json`);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let serialized: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_RUN_FILE_BYTES) {
      throw new Error("Stored run file is not a regular file or exceeds the size limit.");
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_RUN_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_RUN_FILE_BYTES + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_RUN_FILE_BYTES) {
      throw new Error("Stored run file exceeds the size limit.");
    }
    serialized = Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
  const parsed: unknown = JSON.parse(serialized);
  const isObject = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const isTimestamp = (value: unknown): value is string =>
    typeof value === "string" && Number.isFinite(Date.parse(value));
  const runStatuses = ["pending", "awaiting_approval", "running", "completed", "failed", "cancelled"];
  const taskStatuses = ["pending", "awaiting_approval", "running", "completed", "failed", "blocked"];
  const eventTypes = ["approval_required", "approved", "rejected", "started", "completed", "failed", "blocked", "budget_exceeded"];

  if (!isObject(parsed) ||
      parsed.id !== runId ||
      typeof parsed.goal !== "string" || !parsed.goal.trim() ||
      !runStatuses.includes(String(parsed.status)) ||
      !isTimestamp(parsed.createdAt) || !isTimestamp(parsed.updatedAt) ||
      !Array.isArray(parsed.tasks) || parsed.tasks.length > 1000 ||
      !Array.isArray(parsed.events) || parsed.events.length > 10000) {
    throw new Error("Stored run file has an invalid format.");
  }

  if ("tokenUsage" in parsed) {
    const usage = parsed.tokenUsage;
    if (!isObject(usage) ||
        !Number.isSafeInteger(usage.estimatedTokensUsed) || (usage.estimatedTokensUsed as number) < 0 ||
        !isObject(usage.estimatedTokensByAgent) ||
        Object.entries(usage.estimatedTokensByAgent).some(([agent, value]) => !agent.trim() || !Number.isSafeInteger(value) || (value as number) < 0)) {
      throw new Error("Stored run file contains invalid token usage.");
    }
  }

  const taskIds = new Set<string>();
  for (const record of parsed.tasks) {
    if (!isObject(record) || !isObject(record.task) ||
        typeof record.task.id !== "string" || !record.task.id.trim() ||
        typeof record.task.agent !== "string" || !record.task.agent.trim() ||
        typeof record.task.title !== "string" || !record.task.title.trim() ||
        typeof record.task.prompt !== "string" || !record.task.prompt.trim() ||
        !taskStatuses.includes(String(record.status))) {
      throw new Error("Stored run file contains an invalid task record.");
    }
    if (taskIds.has(record.task.id)) throw new Error("Stored run file contains duplicate task identifiers.");
    taskIds.add(record.task.id);
    if ("dependsOn" in record.task &&
        (!Array.isArray(record.task.dependsOn) ||
         record.task.dependsOn.some((id: unknown) => typeof id !== "string" || !id.trim()) ||
         new Set(record.task.dependsOn).size !== record.task.dependsOn.length)) {
      throw new Error("Stored run file contains invalid task dependencies.");
    }
    if ("requiresApproval" in record.task && typeof record.task.requiresApproval !== "boolean") {
      throw new Error("Stored run file contains invalid approval requirements.");
    }
    if ("result" in record &&
        (!isObject(record.result) || typeof record.result.content !== "string" ||
         typeof record.result.provider !== "string" || !record.result.provider.trim() ||
         ("model" in record.result && typeof record.result.model !== "string"))) {
      throw new Error("Stored run file contains an invalid task result.");
    }
    if ("error" in record && typeof record.error !== "string") {
      throw new Error("Stored run file contains an invalid task error.");
    }
    if ("approval" in record) {
      const approval = record.approval;
      if (!isObject(approval) || !["approved", "rejected"].includes(String(approval.decision)) ||
          typeof approval.reviewer !== "string" || !approval.reviewer.trim() ||
          !isTimestamp(approval.at) ||
          ("reason" in approval && typeof approval.reason !== "string")) {
        throw new Error("Stored run file contains an invalid approval record.");
      }
    }
  }
  for (const record of parsed.tasks) {
    const dependencies = record.task.dependsOn as string[] | undefined;
    if (dependencies?.some(id => !taskIds.has(id) || id === record.task.id)) {
      throw new Error("Stored run file contains an unknown or self-referencing task dependency.");
    }
  }
  for (const event of parsed.events) {
    if (!isObject(event) || !isTimestamp(event.at) ||
        typeof event.taskId !== "string" ||
        !eventTypes.includes(String(event.type)) ||
        typeof event.message !== "string") {
      throw new Error("Stored run file contains an invalid event record.");
    }
    if (event.taskId && event.taskId !== "*" && !taskIds.has(event.taskId)) {
      throw new Error("Stored run file contains an event for an unknown task.");
    }
  }
  return parsed as unknown as RunRecord;
}

export async function listRuns(projectPath: string): Promise<RunRecord[]> {
  const directory = await safeRunsDirectory(projectPath);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const runs: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    if (!RUN_ID_PATTERN.test(id) || id.includes("..")) continue;
    try {
      runs.push(await loadRun(projectPath, id));
    } catch {
      // Ignore malformed records; callers can inspect the .forge/runs directory.
    }
  }
  return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function decideTaskApproval(
  projectPath: string,
  runId: string,
  taskId: string,
  decision: "approved" | "rejected",
  reviewer: string,
  reason?: string,
): Promise<RunRecord> {
  return withRunExecutionLock(projectPath, runId, () => withRunLock(projectPath, runId, async () => {
    const run = await loadRun(projectPath, runId);
    const record = run.tasks.find(item => item.task.id === taskId);
    if (!record) throw new Error("Task not found in this run.");
    if (record.approval) throw new Error("This task already has an approval decision.");
    if (record.status !== "awaiting_approval") throw new Error("Only tasks awaiting approval can receive a decision.");
    const at = new Date().toISOString();
    const safeReviewer = reviewer.trim().slice(0, 80) || "local-user";
    const safeReason = reason?.trim().slice(0, 1000);
    record.approval = { decision, reviewer: safeReviewer, ...(safeReason ? { reason: safeReason } : {}), at };
    if (decision === "approved") {
      record.status = "pending";
      run.status = "pending";
    } else {
      record.status = "failed";
      record.error = safeReason || "Task rejected during human review.";
      run.status = "failed";
    }
    run.updatedAt = at;
    run.events.push({
      at, taskId, type: decision,
      message: decision === "approved"
        ? `Approved by ${safeReviewer}. Task is ready for an explicit subsequent run.`
        : `Rejected by ${safeReviewer}.${safeReason ? ` Reason: ${safeReason}` : ""}`,
    });
    await writeRunUnlocked(projectPath, run);
    return run;
  }));
}

/**
 * Marks work interrupted by a process restart as failed and ambiguous.
 * Provider calls are never replayed automatically: a remote provider may have
 * completed the request before the local process stopped persisting its result.
 */
export async function recoverInterruptedRun(projectPath: string, runId: string): Promise<RunRecord> {
  return withRunLock(projectPath, runId, async () => {
    const run = await loadRun(projectPath, runId);
    const interrupted = run.tasks.filter(record => record.status === "running");
    if (interrupted.length === 0) return run;
    const at = new Date().toISOString();
    for (const record of interrupted) {
      record.status = "failed";
      record.error = "Execution was interrupted. Provider outcome is unknown; FORGE did not automatically retry this task.";
      run.events.push({
        at,
        taskId: record.task.id,
        type: "failed",
        message: "Process interruption detected. Provider outcome may be unknown; explicit review is required before any retry.",
      });
    }
    run.status = "failed";
    run.updatedAt = at;
    await writeRunUnlocked(projectPath, run);
    return run;
  });
}
