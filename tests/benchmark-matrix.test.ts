import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeBenchmarkMatrix, fingerprintAgentConfig, formatBenchmarkMatrix, saveBenchmarkMatrix, validateBenchmarkMatrix } from "../src/core/benchmark-matrix.js";

const config = {
  id: "model-comparison",
  name: "Model comparison",
  repeats: 2,
  candidates: [
    { id: "model-a", provider: "openai" as const, model: "model-a" },
    { id: "model-b", provider: "claude-code" as const, model: "model-b" },
  ],
};

describe("automated benchmark matrix", () => {
  it("validates candidate definitions and limits run volume", () => {
    expect(validateBenchmarkMatrix(config)).toEqual(config);
    expect(() => validateBenchmarkMatrix({ ...config, repeats: 4 })).toThrow(/between 1 and 3/);
    expect(() => validateBenchmarkMatrix({ ...config, candidates: [...config.candidates, { id: "c", provider: "openai", model: "c" }, { id: "d", provider: "openai", model: "d" }, { id: "e", provider: "openai", model: "e" }] })).toThrow(/between 2 and 4/);
    expect(() => validateBenchmarkMatrix({ ...config, candidates: [{ ...config.candidates[0] }, { ...config.candidates[0] }] })).toThrow(/unique/);
  });

  it("fingerprints configuration files deterministically and validates snapshot IDs", () => {
    const first = fingerprintAgentConfig([{ path: "skills/secure.md", sha256: "b".repeat(64) }, { path: "agents/planner.md", sha256: "a".repeat(64) }]);
    const reordered = fingerprintAgentConfig([{ path: "agents/planner.md", sha256: "a".repeat(64) }, { path: "skills/secure.md", sha256: "b".repeat(64) }]);
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(() => validateBenchmarkMatrix({ ...config, candidates: [{ ...config.candidates[0], configVersionId: "../escape" }, config.candidates[1]] })).toThrow(/configVersionId/);
  });

  it("revalidates matrix config at execution time", async () => {
    const invalid = { ...config, repeats: 0 };
    await expect(executeBenchmarkMatrix(invalid, async () => ({
      runId: "should-not-run", score: 100, passed: true, durationMs: 1, estimatedTokens: 1,
    }))).rejects.toThrow(/repeats must be between 1 and 3/);
  });

  it("runs each candidate for each repeat and continues after an isolated failure", async () => {
    const calls: string[] = [];
    const report = await executeBenchmarkMatrix(config, async (candidate, repeat) => {
      calls.push(candidate.id + ":" + repeat);
      if (candidate.id === "model-b" && repeat === 1) throw new Error("temporary provider error");
      return { runId: candidate.id + "-" + repeat, score: candidate.id === "model-a" ? 80 + repeat : 90, passed: true, durationMs: 1000, estimatedTokens: 300, agentScores: [{ agent: "security-reviewer", caseId: "security", score: candidate.id === "model-a" ? 80 + repeat : 90, passed: true, skillIds: ["secure-changes"] }] };
    });
    expect(calls).toEqual(["model-a:1", "model-a:2", "model-b:1", "model-b:2"]);
    expect(report.results).toHaveLength(4);
    expect(report.results[2]?.status).toBe("failed");
    expect(report.summary.find(item => item.candidateId === "model-a")?.averageScore).toBe(81.5);
    expect(report.summary.find(item => item.candidateId === "model-b")?.completed).toBe(1);
    expect(report.agentSummary.find(item => item.agent === "security-reviewer" && item.candidateId === "model-a")?.averageScore).toBe(81.5);
    expect(report.agentSummary.find(item => item.agent === "security-reviewer")?.skillsObserved).toContain("secure-changes");
    expect(formatBenchmarkMatrix(report)).toContain("Per-agent scorecards:");
    expect(formatBenchmarkMatrix(report)).toContain("temporary provider error");
  });

  it("validates controlled skill experiments require identical model and explicit skill variants", () => {
    const experiment = {
      ...config,
      candidates: [
        { id: "baseline", provider: "openai" as const, model: "same-model", skillIds: [] },
        { id: "treatment", provider: "openai" as const, model: "same-model", skillIds: ["secure-changes"] },
      ],
      skillExperiment: { baselineCandidateId: "baseline", treatmentCandidateId: "treatment", skillIds: ["secure-changes"] },
    };
    expect(validateBenchmarkMatrix(experiment)).toEqual(experiment);
    expect(() => validateBenchmarkMatrix({ ...experiment, candidates: experiment.candidates.map((item, index) => index ? { ...item, model: "different-model" } : item) })).toThrow(/same provider and model/);
    expect(() => validateBenchmarkMatrix({ ...experiment, candidates: experiment.candidates.map((item, index) => index ? { ...item, skillIds: [] } : item) })).toThrow(/exactly match/);
    expect(() => validateBenchmarkMatrix({ ...experiment, candidates: experiment.candidates.map((item, index) => index ? item : { ...item, skillIds: ["documentation"] }) })).toThrow(/exactly match/);
  });

  it("reports paired skill treatment deltas overall and per agent", async () => {
    const experiment = {
      ...config,
      repeats: 2,
      candidates: [
        { id: "baseline", provider: "openai" as const, model: "same-model", skillIds: [] },
        { id: "treatment", provider: "openai" as const, model: "same-model", skillIds: ["secure-changes"] },
      ],
      skillExperiment: { baselineCandidateId: "baseline", treatmentCandidateId: "treatment", skillIds: ["secure-changes"] },
    };
    const report = await executeBenchmarkMatrix(experiment, async candidate => {
      const treatment = candidate.id === "treatment";
      return { runId: candidate.id, score: treatment ? 90 : 80, passed: treatment, durationMs: treatment ? 1200 : 1000, estimatedTokens: treatment ? 550 : 500, agentScores: [{ agent: "security-reviewer", caseId: "auth-review", score: treatment ? 90 : 80, passed: treatment, skillIds: candidate.skillIds ?? [] }] };
    });
    expect(report.skillExperiment).toMatchObject({
      baselineCandidateId: "baseline", treatmentCandidateId: "treatment", skillIds: ["secure-changes"],
      baselineScore: 80, treatmentScore: 90, scoreDelta: 10,
      baselinePassRate: 0, treatmentPassRate: 100, passRateDelta: 100,
      durationChangePercent: 20, tokenChangePercent: 10,
    });
    expect(report.skillExperiment?.agentDeltas[0]).toMatchObject({ agent: "security-reviewer", scoreDelta: 10, passRateDelta: 100 });
    expect(formatBenchmarkMatrix(report)).toContain("Controlled skill experiment:");
  });

  it("persists matrix reports inside the project's local FORGE state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-matrix-"));
    try {
      const report = await executeBenchmarkMatrix(config, async (candidate, repeat) => ({
        runId: candidate.id + "-" + repeat, score: 85, passed: true, durationMs: 100, estimatedTokens: 50,
      }));
      report.suiteId = "engineering-basics";
      report.goal = "Review the project architecture";
      const saved = await saveBenchmarkMatrix(root, report);
      const persisted = JSON.parse(await readFile(saved, "utf8"));
      expect(persisted.suiteId).toBe("engineering-basics");
      expect(persisted.results).toHaveLength(4);
      expect(saved).toContain(path.join(".forge", "benchmark-matrices"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
