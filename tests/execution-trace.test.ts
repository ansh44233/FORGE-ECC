import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveExecutionTrace, loadExecutionTrace } from "../src/core/execution-trace.js";

describe("execution trace persistence", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
  it("persists per-agent metrics and aggregate totals", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-trace-"));
    const entries = [{ taskId: "a", agent: "planner", tier: "balanced" as const, model: "model-x", provider: "test", startedAt: new Date().toISOString(), durationMs: 125, outcome: "success" as const, inputTokensEstimate: 100, outputTokensEstimate: 40 }];
    const file = await saveExecutionTrace(root, "forge-test-run", entries);
    await saveExecutionTrace(root, "forge-test-run", [{ ...entries[0]!, taskId: "b", agent: "reviewer", inputTokensEstimate: 50, outputTokensEstimate: 20 }]);
    const disk = JSON.parse(await readFile(file, "utf8")) as { entries: unknown[] };
    expect(disk.entries).toHaveLength(2);
    const stored = await loadExecutionTrace(root, "forge-test-run");
    expect(stored.totals.estimatedInputTokens).toBe(150);
    expect(stored.totals.estimatedOutputTokens).toBe(60);
    expect(stored.entries).toHaveLength(2);
    expect(stored.entries[0]?.durationMs).toBe(125);
    expect(stored.providers).toEqual([
      { name: "test", requests: 2, successes: 2, fallbacks: 0, failures: 0, retries: 0, durationMs: 250 },
    ]);
    expect(file).toContain(path.join(".forge", "traces"));
  });
  it("rejects invalid run identifiers", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-trace-"));
    await expect(loadExecutionTrace(root, "../escape")).rejects.toThrow("Invalid FORGE run identifier");
  });

  it("rejects competing writers instead of losing trace updates", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-trace-lock-"));
    const entry = { taskId: "a", agent: "planner", tier: "balanced" as const, model: "model-x", provider: "test", startedAt: new Date().toISOString(), durationMs: 10, outcome: "success" as const, inputTokensEstimate: 1, outputTokensEstimate: 1 };
    const results = await Promise.allSettled([
      saveExecutionTrace(root, "forge-concurrent-trace", [entry]),
      saveExecutionTrace(root, "forge-concurrent-trace", [{ ...entry, taskId: "b" }]),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    await expect(loadExecutionTrace(root, "forge-concurrent-trace")).resolves.toMatchObject({
      entries: [expect.objectContaining({ taskId: expect.stringMatching(/^(a|b)$/) })],
    });
  });

  it("rejects malformed persisted trace entries", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-trace-invalid-"));
    const directory = path.join(root, ".forge", "traces");
    await import("node:fs/promises").then(fs => fs.mkdir(directory, { recursive: true }));
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(directory, "forge-bad-trace.json"), JSON.stringify({
      version: 1, runId: "forge-bad-trace", createdAt: new Date().toISOString(),
      entries: [{ taskId: "bad", outcome: "success", inputTokensEstimate: "not-a-number" }],
      totals: {}, providers: [],
    })));
    await expect(loadExecutionTrace(root, "forge-bad-trace")).rejects.toThrow("invalid format");
  });
});
