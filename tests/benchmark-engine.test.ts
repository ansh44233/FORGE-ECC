import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBenchmarkTrial, formatBenchmark, listBenchmarks, recordBenchmarkTrial, type BenchmarkTrial } from "../src/core/benchmark-engine.js";
import type { EvaluationReport } from "../src/core/evaluation-engine.js";
import type { ExecutionTraceDocument } from "../src/core/execution-trace.js";

const report = (runId: string, score: number): EvaluationReport => ({
  version: 1, suiteId: "engineering-basics", suiteName: "Engineering Basics", runId,
  evaluatedAt: new Date().toISOString(), score, passed: score >= 80, cases: [],
  summary: { total: 0, scored: 0, passed: 0, missingOutput: 0 }
});
const trace = (runId: string, model: string, durationMs: number): ExecutionTraceDocument => ({
  version: 1, runId, createdAt: new Date().toISOString(),
  entries: [{ taskId: "task-1", agent: "planner", tier: "balanced", model, provider: "openai", startedAt: new Date().toISOString(), durationMs, outcome: "success", inputTokensEstimate: 100, outputTokensEstimate: 50 }],
  totals: { tasks: 1, successes: 1, fallbacks: 0, failures: 0, estimatedInputTokens: 100, estimatedOutputTokens: 50, durationMs },
  providers: [{ name: "openai", requests: 1, successes: 1, fallbacks: 0, failures: 0, retries: 0, durationMs }]
});

describe("Benchmark Lab", () => {
  it("aggregates real runs by provider and model and computes consistency", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-bench-"));
    try {
      const first = createBenchmarkTrial(report("forge-run-1", 90), trace("forge-run-1", "model-a", 1000));
      const second = createBenchmarkTrial(report("forge-run-2", 70), trace("forge-run-2", "model-a", 2000));
      const third = createBenchmarkTrial(report("forge-run-3", 95), trace("forge-run-3", "model-b", 500));
      await recordBenchmarkTrial(root, first);
      const document = await recordBenchmarkTrial(root, second);
      await recordBenchmarkTrial(root, third);
      const loaded = await listBenchmarks(root);
      expect(loaded).toHaveLength(1);
      const group = document.groups[0]!;
      expect(group.key).toBe("openai / model-a");
      expect(group.averageScore).toBe(80);
      expect(group.scoreStdDev).toBe(10);
      expect(group.passRate).toBe(50);
      expect(formatBenchmark(document)).toContain("Benchmark Lab");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps model-judge scores separate from deterministic rubric scores", () => {
    const judged = { ...report("forge-judged", 75), judge: { provider: "judge-api", model: "judge-model", evaluatedCases: 1, averageScore: 91, passed: true }, judgedCases: [] };
    const trial = createBenchmarkTrial(judged, trace("forge-judged", "candidate-model", 1200));
    expect(trial.score).toBe(75);
    expect(trial.judgeScore).toBe(91);
    expect(trial.judgeProvider).toBe("judge-api");
    expect(trial.judgePassed).toBe(true);
  });

  it("replaces a duplicate run instead of inflating repeat counts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-bench-dedupe-"));
    try {
      const trial: BenchmarkTrial = { runId: "forge-repeat", recordedAt: new Date().toISOString(), suiteId: "engineering-basics", suiteName: "Engineering Basics", score: 88, passed: true, provider: "openai", models: ["model-a"], tasks: 2, failures: 0, fallbacks: 0, retries: 0, estimatedInputTokens: 120, estimatedOutputTokens: 80, durationMs: 900 };
      await recordBenchmarkTrial(root, trial);
      const document = await recordBenchmarkTrial(root, { ...trial, score: 92 });
      expect(document.trials).toHaveLength(1);
      expect(document.groups[0]?.averageScore).toBe(92);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
