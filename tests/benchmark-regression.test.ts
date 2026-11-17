import { describe, expect, it } from "vitest";
import { analyzeBenchmarkRegression, formatBenchmarkRegression } from "../src/core/benchmark-regression.js";
import type { BenchmarkMatrixReport } from "../src/core/benchmark-matrix.js";

function report(createdAt: string, score: number, passRate: number, duration: number, tokens: number, stdDev = 4): BenchmarkMatrixReport {
  return {
    version: 1, matrixId: "model-comparison", matrixName: "Model comparison", suiteId: "engineering-basics",
    goal: "Review architecture risks", createdAt,
    results: [{ candidateId: "model-a", provider: "openai", model: "gpt-test", repeat: 1, runId: "run-" + createdAt, score, passed: passRate >= 80, durationMs: duration, estimatedTokens: tokens, status: "completed" }],
    summary: [{ candidateId: "model-a", provider: "openai", model: "gpt-test", trials: 1, completed: 1, averageScore: score, passRate, scoreStdDev: stdDev, averageDurationMs: duration, averageEstimatedTokens: tokens }],
  };
}

describe("benchmark regression intelligence", () => {
  it("blocks material quality and pass-rate regressions", () => {
    const result = analyzeBenchmarkRegression([
      report("2026-11-15T10:00:00.000Z", 90, 100, 1000, 500),
      report("2026-11-16T10:00:00.000Z", 82, 75, 1100, 520),
    ], "model-comparison");
    expect(result.status).toBe("blocked");
    expect(result.candidates[0]?.scoreDelta).toBe(-8);
    expect(result.candidates[0]?.regressions).toHaveLength(2);
    expect(formatBenchmarkRegression(result)).toContain("REGRESSION:");
  });

  it("warns about cost proxy, latency and score instability without blocking", () => {
    const result = analyzeBenchmarkRegression([
      report("2026-11-15T10:00:00.000Z", 90, 100, 1000, 500),
      report("2026-11-16T10:00:00.000Z", 89, 100, 1300, 700, 18),
    ]);
    expect(result.status).toBe("warning");
    expect(result.candidates[0]?.warnings).toHaveLength(3);
  });

  it("requires a comparable baseline and ignores mismatched goals", () => {
    expect(analyzeBenchmarkRegression([report("2026-11-16T10:00:00.000Z", 90, 100, 1000, 500)]).status).toBe("insufficient-history");
    const differentGoal = report("2026-11-15T10:00:00.000Z", 90, 100, 1000, 500);
    differentGoal.goal = "Different goal";
    expect(analyzeBenchmarkRegression([differentGoal, report("2026-11-16T10:00:00.000Z", 90, 100, 1000, 500)]).status).toBe("insufficient-history");
  });

  it("detects per-agent regressions and retains observed skill context", () => {
    const baseline = report("2026-11-15T10:00:00.000Z", 90, 100, 1000, 500);
    const current = report("2026-11-16T10:00:00.000Z", 90, 100, 1000, 500);
    baseline.agentSummary = [{ candidateId: "model-a", provider: "openai", model: "gpt-test", agent: "security-reviewer", trials: 1, completed: 1, averageScore: 95, passRate: 100, skillsObserved: ["secure-changes"] }];
    current.agentSummary = [{ candidateId: "model-a", provider: "openai", model: "gpt-test", agent: "security-reviewer", trials: 1, completed: 1, averageScore: 80, passRate: 50, skillsObserved: ["secure-changes"] }];
    const result = analyzeBenchmarkRegression([baseline, current]);
    expect(result.status).toBe("blocked");
    expect(result.agents[0]?.regressions).toHaveLength(2);
    expect(result.agents[0]?.skillsObserved).toContain("secure-changes");
    expect(formatBenchmarkRegression(result)).toContain("Per-agent regressions:");
  });

  it("does not claim release readiness when a candidate lacks a baseline", () => {
    const baseline = report("2026-11-15T10:00:00.000Z", 90, 100, 1000, 500);
    const current = report("2026-11-16T10:00:00.000Z", 90, 100, 1000, 500);
    current.summary.push({ candidateId: "new-model", provider: "openai", model: "gpt-new", trials: 1, completed: 1, averageScore: 95, passRate: 100, scoreStdDev: 0, averageDurationMs: 900, averageEstimatedTokens: 450 });
    expect(analyzeBenchmarkRegression([baseline, current]).status).toBe("insufficient-history");
  });
});
