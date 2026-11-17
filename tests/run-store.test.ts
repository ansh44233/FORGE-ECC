import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../src/core/orchestrator.js";
import { decideTaskApproval, listRuns, loadRun, recoverInterruptedRun, saveRun, withRunExecutionLock } from "../src/core/run-store.js";

let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("local run history", () => {
  it("saves, loads, and lists run records", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-store-"));
    const run = createRun("Track a plan", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft a plan" },
    ]);
    await saveRun(root, run);
    const loaded = await loadRun(root, run.id);
    const history = await listRuns(root);
    expect(loaded.id).toBe(run.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.goal).toBe("Track a plan");
  });

  it("persists cumulative token usage with the run record", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-token-usage-"));
    const run = createRun("Preserve budget across resume", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft a plan" },
    ]);
    await saveRun(root, { ...run, tokenUsage: { estimatedTokensUsed: 42, estimatedTokensByAgent: { planner: 42 } } });
    await expect(loadRun(root, run.id)).resolves.toMatchObject({
      tokenUsage: { estimatedTokensUsed: 42, estimatedTokensByAgent: { planner: 42 } },
    });
  });

  it("lists valid runs while skipping malformed history files", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-malformed-list-"));
    const validRun = createRun("Keep valid history visible", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft a plan" },
    ]);
    await saveRun(root, validRun);
    await writeFile(
      path.join(root, ".forge", "runs", "run_malformed.json"),
      "{ this is not valid JSON",
    );

    const history = await listRuns(root);
    expect(history.map((run) => run.id)).toEqual([validRun.id]);
  });

  it("rejects malformed persisted token usage", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-invalid-token-usage-"));
    const run = createRun("Reject corrupt budget", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft a plan" },
    ]);
    await saveRun(root, run);
    const file = path.join(root, ".forge", "runs", run.id + ".json");
    await writeFile(file, JSON.stringify({ ...run, tokenUsage: { estimatedTokensUsed: -1, estimatedTokensByAgent: { planner: 3 } } }));
    await expect(loadRun(root, run.id)).rejects.toThrow(/invalid token usage/);
  });
  it("records one-time approval and rejection decisions with audit events", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-approval-"));
    const run = createRun("Gate sensitive tasks", [
      { id: "approve-me", agent: "reviewer", title: "Review", prompt: "Review", requiresApproval: true },
      { id: "reject-me", agent: "reviewer", title: "Reject", prompt: "Reject", requiresApproval: true },
    ]);
    const held = { ...run, status: "awaiting_approval" as const, tasks: run.tasks.map(task => ({ ...task, status: "awaiting_approval" as const })) };
    await saveRun(root, held);
    const approved = await decideTaskApproval(root, run.id, "approve-me", "approved", "local-user");
    expect(approved.tasks[0]?.status).toBe("pending");
    expect(approved.tasks[0]?.approval?.decision).toBe("approved");
    await expect(decideTaskApproval(root, run.id, "approve-me", "approved", "local-user")).rejects.toThrow(/already/);
    const rejected = await decideTaskApproval(root, run.id, "reject-me", "rejected", "local-user", "Needs changes");
    expect(rejected.tasks[1]?.status).toBe("failed");
    expect(rejected.tasks[1]?.approval?.reason).toBe("Needs changes");
    expect(rejected.events.map(event => event.type)).toContain("rejected");
  });

  it("recovers interrupted provider work without replaying it", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-recovery-"));
    const run = createRun("Recover after restart", [
      { id: "finished", agent: "planner", title: "Finished", prompt: "Done" },
      { id: "interrupted", agent: "reviewer", title: "Interrupted", prompt: "May have reached provider" },
      { id: "not-started", agent: "tester", title: "Not started", prompt: "Wait" },
    ]);
    const interrupted = {
      ...run,
      status: "running" as const,
      tasks: run.tasks.map(task => ({
        ...task,
        status: task.task.id === "finished" ? "completed" as const
          : task.task.id === "interrupted" ? "running" as const : "pending" as const,
        ...(task.task.id === "finished" ? { result: { provider: "test", content: "done" } } : {}),
      })),
    };
    await saveRun(root, interrupted);
    const recovered = await recoverInterruptedRun(root, run.id);
    expect(recovered.status).toBe("failed");
    expect(recovered.tasks.find(task => task.task.id === "finished")?.status).toBe("completed");
    expect(recovered.tasks.find(task => task.task.id === "interrupted")?.status).toBe("failed");
    expect(recovered.tasks.find(task => task.task.id === "interrupted")?.error).toContain("did not automatically retry");
    expect(recovered.tasks.find(task => task.task.id === "not-started")?.status).toBe("pending");
    expect(recovered.events.some(event => event.message.includes("outcome may be unknown"))).toBe(true);
    await expect(recoverInterruptedRun(root, run.id)).resolves.toMatchObject({ status: "failed" });
  });

  it("returns an empty list when no run history exists", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-store-"));
    await expect(listRuns(root)).resolves.toEqual([]);
  });

  it("rejects a symlinked run-history directory", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-symlink-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "forge-run-outside-"));
    await symlink(outside, path.join(root, ".forge"));
    const run = createRun("Symlink check", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft" },
    ]);
    await expect(saveRun(root, run)).rejects.toThrow(/symbolic links/);
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects symlinked run files and malformed stored task records", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-file-"));
    const run = createRun("File validation", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft" },
    ]);
    await saveRun(root, run);
    const directory = path.join(root, ".forge", "runs");
    const file = path.join(directory, run.id + ".json");
    await rm(file);
    const outside = path.join(root, "outside.json");
    await writeFile(outside, JSON.stringify(run));
    await symlink(outside, file);
    await expect(loadRun(root, run.id)).rejects.toThrow();
    await rm(file);
    await writeFile(file, JSON.stringify({ ...run, tasks: [{ task: null, status: "pending" }] }));
    await expect(loadRun(root, run.id)).rejects.toThrow(/invalid task record/);
  });

  it("allows only one concurrent approval decision", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-race-"));
    const run = createRun("Serialize approvals", [
      { id: "review", agent: "reviewer", title: "Review", prompt: "Review", requiresApproval: true },
    ]);
    const held = { ...run, status: "awaiting_approval" as const, tasks: run.tasks.map(task => ({ ...task, status: "awaiting_approval" as const })) };
    await saveRun(root, held);
    const decisions = await Promise.allSettled([
      decideTaskApproval(root, run.id, "review", "approved", "reviewer-a"),
      decideTaskApproval(root, run.id, "review", "rejected", "reviewer-b"),
    ]);
    expect(decisions.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter(result => result.status === "rejected")).toHaveLength(1);
    const saved = await loadRun(root, run.id);
    expect(saved.tasks[0]?.approval?.decision).toBeDefined();
    expect(saved.events.filter(event => event.type === "approved" || event.type === "rejected")).toHaveLength(1);
  });

  it("shares one lock between approval and interrupted-run recovery", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-shared-lock-"));
    const run = createRun("Serialize recovery and approval", [
      { id: "review", agent: "reviewer", title: "Review", prompt: "Review", requiresApproval: true },
    ]);
    const held = {
      ...run,
      status: "awaiting_approval" as const,
      tasks: run.tasks.map(task => ({ ...task, status: "awaiting_approval" as const })),
    };
    await saveRun(root, held);
    const directory = path.join(root, ".forge", "runs");
    const lock = path.join(directory, `${run.id}.lock`);

    await (await import("node:fs/promises")).mkdir(lock);
    await expect(recoverInterruptedRun(root, run.id)).rejects.toThrow(/owner\.json/);
    await expect(saveRun(root, { ...held, goal: "must not overwrite while locked" })).rejects.toThrow();
    await expect(loadRun(root, run.id)).resolves.toMatchObject({ goal: "Serialize recovery and approval" });
    await rm(lock, { recursive: true, force: true });

    const running = {
      ...held,
      status: "running" as const,
      tasks: held.tasks.map(task => ({ ...task, status: "running" as const })),
    };
    await saveRun(root, running);
    await (await import("node:fs/promises")).mkdir(lock);
    await expect(decideTaskApproval(root, run.id, "review", "approved", "reviewer")).rejects.toThrow();
    await rm(lock, { recursive: true, force: true });
  });

  it("allows only one process to hold a run execution lease", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-execution-lock-"));
    const run = createRun("Prevent duplicate execution", [
      { id: "task", agent: "planner", title: "Task", prompt: "Execute once" },
    ]);
    await saveRun(root, run);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const first = withRunExecutionLock(root, run.id, async () => {
      entered();
      await hold;
    });
    await started;
    await expect(withRunExecutionLock(root, run.id, async () => {
      throw new Error("second execution must never start");
    })).rejects.toThrow(/locked by another or interrupted/);
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(withRunExecutionLock(root, run.id, async () => "acquired")).resolves.toBe("acquired");
  });

  it("does not allow approval to race an active resume execution", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-approval-execution-"));
    const run = createRun("Serialize approval and execution", [
      { id: "review", agent: "reviewer", title: "Review", prompt: "Review", requiresApproval: true },
    ]);
    const awaiting = {
      ...run,
      status: "awaiting_approval" as const,
      tasks: run.tasks.map(task => ({ ...task, status: "awaiting_approval" as const })),
    };
    await saveRun(root, awaiting);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const execution = withRunExecutionLock(root, run.id, async () => {
      entered();
      await hold;
    });
    await started;
    await expect(decideTaskApproval(root, run.id, "review", "approved", "reviewer"))
      .rejects.toThrow(/locked by another or interrupted/);
    release();
    await execution;
    const approved = await decideTaskApproval(root, run.id, "review", "approved", "reviewer");
    expect(approved.tasks[0]?.approval?.decision).toBe("approved");
    expect(approved.status).toBe("pending");
  });

  it("rejects path-like run identifiers", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-store-"));
    await expect(loadRun(root, "../outside")).rejects.toThrow(/identifier/);
  });

  it("rejects malformed persisted run events and duplicate task IDs", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-invalid-records-"));
    const run = createRun("Validate run records", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft" },
    ]);
    await saveRun(root, run);
    const file = path.join(root, ".forge", "runs", run.id + ".json");
    await writeFile(file, JSON.stringify({ ...run, events: [{ at: "not-a-date", taskId: "draft", type: "started", message: "bad" }] }));
    await expect(loadRun(root, run.id)).rejects.toThrow(/invalid event record/);
    await writeFile(file, JSON.stringify({ ...run, tasks: [run.tasks[0], run.tasks[0]] }));
    await expect(loadRun(root, run.id)).rejects.toThrow(/duplicate task identifiers/);
  });

  it("rejects invalid task results, approvals, and unknown dependencies", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-invalid-task-fields-"));
    const run = createRun("Validate task fields", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft" },
    ]);
    await saveRun(root, run);
    const file = path.join(root, ".forge", "runs", run.id + ".json");
    const task = run.tasks[0]!;
    await writeFile(file, JSON.stringify({ ...run, tasks: [{ ...task, result: { content: 42, provider: "test" } }] }));
    await expect(loadRun(root, run.id)).rejects.toThrow(/invalid task result/);
    await writeFile(file, JSON.stringify({ ...run, tasks: [{ ...task, approval: { decision: "maybe", reviewer: "x", at: "bad" } }] }));
    await expect(loadRun(root, run.id)).rejects.toThrow(/invalid approval record/);
    await writeFile(file, JSON.stringify({ ...run, tasks: [{ ...task, task: { ...task.task, dependsOn: ["missing"] } }] }));
    await expect(loadRun(root, run.id)).rejects.toThrow(/unknown or self-referencing/);
  });

  it("rejects run records that exceed the persistence size limit", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-oversized-"));
    const run = createRun("Oversized run", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "x".repeat(5 * 1024 * 1024) },
    ]);
    await expect(saveRun(root, run)).rejects.toThrow(/maximum file size/);
  });

  it("preserves the previous run record when an oversized update is rejected", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-oversized-update-"));
    const run = createRun("Keep valid history", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Original prompt" },
    ]);
    await saveRun(root, run);
    const oversized = {
      ...run,
      tasks: run.tasks.map((task) => ({
        ...task,
        task: { ...task.task, prompt: "x".repeat(5 * 1024 * 1024) },
      })),
    };

    await expect(saveRun(root, oversized)).rejects.toThrow(/maximum file size/);
    await expect(loadRun(root, run.id)).resolves.toMatchObject({
      id: run.id,
      goal: "Keep valid history",
      tasks: [{ task: { prompt: "Original prompt" } }],
    });
  });

  it("rejects oversized run-history files before parsing them", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-run-oversized-read-"));
    const run = createRun("Oversized stored run", [
      { id: "draft", agent: "planner", title: "Draft", prompt: "Draft" },
    ]);
    await saveRun(root, run);
    const file = path.join(root, ".forge", "runs", run.id + ".json");
    await writeFile(file, " ".repeat(5 * 1024 * 1024 + 1));
    await expect(loadRun(root, run.id)).rejects.toThrow(/exceeds the size limit/);
  });

});
