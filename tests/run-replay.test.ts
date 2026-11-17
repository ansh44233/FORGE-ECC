import { describe, expect, it } from "vitest";
import { createRun } from "../src/core/orchestrator.js";
import { createReplayRun, createTaskRetryRun } from "../src/core/run-replay.js";

describe("run replay", () => {
  it("retains completed prerequisites and resets failed downstream work", () => {
    const source = createRun("Review changes", [
      { id: "inspect", agent: "architect", title: "Inspect", prompt: "Inspect" },
      { id: "review", agent: "reviewer", title: "Review", prompt: "Review", dependsOn: ["inspect"] },
      { id: "summary", agent: "planner", title: "Summary", prompt: "Summarize", dependsOn: ["review"] },
    ]);
    source.tasks[0]!.status = "completed";
    source.tasks[0]!.result = { provider: "test", content: "inspection result" };
    source.tasks[1]!.status = "failed";
    source.tasks[1]!.error = "temporary provider outage";
    source.tasks[2]!.status = "blocked";
    source.tasks[2]!.error = "A required dependency did not complete.";
    const replay = createReplayRun(source);
    expect(replay.id).not.toBe(source.id);
    expect(replay.tasks[0]?.status).toBe("completed");
    expect(replay.tasks[0]?.result?.content).toBe("inspection result");
    expect(replay.tasks[1]?.status).toBe("pending");
    expect(replay.tasks[2]?.status).toBe("pending");
    expect(replay.events.at(-1)?.message).toContain(source.id);
  });
  it("retries one failed task and its blocked dependants without resetting completed work", () => {
    const source = createRun("Focused retry", [
      { id: "done", agent: "architect", title: "Done", prompt: "Done" },
      { id: "failed", agent: "reviewer", title: "Failed", prompt: "Failed", dependsOn: ["done"] },
      { id: "downstream", agent: "planner", title: "Downstream", prompt: "Downstream", dependsOn: ["failed"] },
    ]);
    source.tasks[0]!.status = "completed";
    source.tasks[0]!.result = { provider: "test", content: "preserve me" };
    source.tasks[1]!.status = "failed";
    source.tasks[2]!.status = "blocked";
    const retry = createTaskRetryRun(source, "failed");
    expect(retry.tasks.map(task => task.status)).toEqual(["completed", "pending", "pending"]);
    expect(retry.tasks[0]!.result?.content).toBe("preserve me");
  });
  it("does not replay tasks explicitly rejected by a reviewer", () => {
    const source = createRun("Review", [{ id: "a", agent: "reviewer", title: "A", prompt: "A" }]);
    source.tasks[0]!.status = "failed";
    source.tasks[0]!.approval = { decision: "rejected", reviewer: "reviewer", at: new Date().toISOString() };
    expect(() => createReplayRun(source)).toThrow(/explicitly rejected/);
  });
  it("preserves policy-blocked tasks rather than bypassing a hook", () => {
    const source = createRun("Review", [{ id: "a", agent: "reviewer", title: "A", prompt: "A" }]);
    source.tasks[0]!.status = "blocked";
    source.tasks[0]!.error = "Blocked by policy hook: requires manual review";
    expect(() => createReplayRun(source)).toThrow(/no retryable/);
  });
});
