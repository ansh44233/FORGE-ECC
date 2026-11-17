import { describe, expect, it } from "vitest";
import { assessAgentEvolution, formatAgentEvolutionAssessment } from "../src/core/agent-evolution.js";
import type { BenchmarkMatrixReport } from "../src/core/benchmark-matrix.js";

function fixture(overrides: Partial<BenchmarkMatrixReport> = {}): BenchmarkMatrixReport {
  return {
    version: 1, matrixId: "evolution-matrix", matrixName: "Evolution", suiteId: "engineering-basics", goal: "review",
    createdAt: "2026-11-16T00:00:00.000Z",
    results: [
      { candidateId: "baseline", provider: "openai", model: "model-a", repeat: 1, runId: "b1", score: 80, passed: true, durationMs: 1000, estimatedTokens: 500, status: "completed" },
      { candidateId: "baseline", provider: "openai", model: "model-a", repeat: 2, runId: "b2", score: 82, passed: true, durationMs: 1000, estimatedTokens: 500, status: "completed" },
      { candidateId: "treatment", provider: "openai", model: "model-a", repeat: 1, runId: "t1", score: 90, passed: true, durationMs: 1050, estimatedTokens: 520, status: "completed" },
      { candidateId: "treatment", provider: "openai", model: "model-a", repeat: 2, runId: "t2", score: 92, passed: true, durationMs: 1050, estimatedTokens: 520, status: "completed" }
    ],
    summary: [
      { candidateId: "baseline", provider: "openai", model: "model-a", trials: 2, completed: 2, averageScore: 81, passRate: 100, scoreStdDev: 1, averageDurationMs: 1000, averageEstimatedTokens: 500 },
      { candidateId: "treatment", provider: "openai", model: "model-a", trials: 2, completed: 2, averageScore: 91, passRate: 100, scoreStdDev: 1, averageDurationMs: 1050, averageEstimatedTokens: 520 }
    ],
    skillExperiment: { baselineCandidateId: "baseline", treatmentCandidateId: "treatment", skillIds: ["secure-changes"], baselineScore: 81, treatmentScore: 91, scoreDelta: 10, baselinePassRate: 100, treatmentPassRate: 100, passRateDelta: 0, baselineDurationMs: 1000, treatmentDurationMs: 1050, durationChangePercent: 5, baselineEstimatedTokens: 500, treatmentEstimatedTokens: 520, tokenChangePercent: 4, agentDeltas: [] },
    candidateProvenance: [{ candidateId: "treatment", configVersionId: "cfg-aaaaaaaaaaaa", fingerprint: "a".repeat(64) }],
    ...overrides
  };
}
describe("agent evolution assessment", () => {
  it("marks an improved, pinned treatment eligible for human review", () => {
    const assessment = assessAgentEvolution(fixture());
    expect(assessment.status).toBe("eligible-for-review");
    expect(assessment.candidateConfigPinned).toBe(true);
    expect(formatAgentEvolutionAssessment(assessment)).toContain("ELIGIBLE-FOR-REVIEW");
  });
  it("holds treatment with missing provenance or efficiency warning", () => {
    const report = fixture({ candidateProvenance: undefined });
    const assessment = assessAgentEvolution(report);
    expect(assessment.status).toBe("hold");
    expect(assessment.candidateConfigPinned).toBe(false);
  });
  it("rejects quality regressions in any agent", () => {
    const report = fixture({ skillExperiment: { ...fixture().skillExperiment!, agentDeltas: [{ agent: "security-reviewer", baselineScore: 90, treatmentScore: 80, scoreDelta: -10, baselinePassRate: 100, treatmentPassRate: 70, passRateDelta: -30 }] } });
    expect(assessAgentEvolution(report).status).toBe("reject");
  });
  it("requires at least two completed trials per candidate", () => {
    const report = fixture({ summary: fixture().summary.map(item => ({ ...item, completed: 1 })) });
    expect(assessAgentEvolution(report).status).toBe("insufficient-evidence");
  });
  it("rejects reports without a controlled skill experiment", () => {
    expect(() => assessAgentEvolution(fixture({ skillExperiment: undefined }))).toThrow("no controlled skill experiment");
  });
});
