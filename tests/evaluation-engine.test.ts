import { describe, expect, it } from "vitest";
import { createRun } from "../src/core/orchestrator.js";
import { evaluateRun, evaluateRunWithJudge, formatEvaluationReport, loadEvaluationSuites } from "../src/core/evaluation-engine.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

describe("deterministic agent evaluation", () => {
  it("scores weighted required and forbidden terms against saved agent output", () => {
    const run = createRun("Baseline", [{ id: "plan", agent: "planner", title: "Plan", prompt: "Plan work" }]);
    run.tasks[0]!.status = "completed";
    run.tasks[0]!.result = { provider: "mock", content: "Acceptance criteria are clear. One risk remains." };
    const report = evaluateRun(run, {
      id: "quality-baseline", name: "Quality baseline", description: "Test",
      cases: [{ id: "planner-output", description: "Check plan", agent: "planner", criteria: [
        { id: "acceptance", weight: 3, requiredTerms: ["acceptance criteria"] },
        { id: "risk", weight: 1, requiredTerms: ["risk"] },
        { id: "no-false-claim", weight: 2, forbiddenTerms: ["tests passed"] }
      ] }]
    });
    expect(report.score).toBe(100);
    expect(report.passed).toBe(true);
    expect(report.summary.passed).toBe(1);
    expect(formatEvaluationReport(report)).toContain("100/100");
  });

  it("weights failed criteria and reports missing output explicitly", () => {
    const run = createRun("Baseline", [{ id: "review", agent: "code-reviewer", title: "Review", prompt: "Review" }]);
    run.tasks[0]!.status = "completed";
    run.tasks[0]!.result = { provider: "mock", content: "A brief review." };
    const report = evaluateRun(run, {
      id: "review-checks", name: "Review checks", description: "Test",
      cases: [
        { id: "required", description: "Need evidence", agent: "code-reviewer", criteria: [{ id: "evidence", weight: 4, requiredTerms: ["evidence"] }] },
        { id: "missing", description: "Missing role output", agent: "security-reviewer", criteria: [{ id: "mitigation", weight: 1, requiredTerms: ["mitigation"] }] }
      ]
    });
    expect(report.score).toBe(0);
    expect(report.passed).toBe(false);
    expect(report.summary.missingOutput).toBe(1);
    expect(report.cases[1]?.status).toBe("missing-output");
  });

  it("loads validated suites from .forge/evals", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-evals-"));
    try {
      await mkdir(path.join(root, ".forge", "evals"), { recursive: true });
      await writeFile(path.join(root, ".forge", "evals", "baseline.json"), JSON.stringify({
        id: "baseline-suite", name: "Baseline", description: "Test",
        cases: [{ id: "planner-case", description: "Planner", agent: "planner", criteria: [{ id: "must-plan", weight: 1, requiredTerms: ["plan"] }] }]
      }));
      const suites = await loadEvaluationSuites(root);
      expect(suites.map(suite => suite.id)).toEqual(["baseline-suite"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("runs a model judge and accepts only verbatim evidence quotes", async () => {
    const run = createRun("Judge baseline", [{ id: "review", agent: "code-reviewer", title: "Review", prompt: "Review the change" }]);
    run.tasks[0]!.status = "completed";
    run.tasks[0]!.result = { provider: "mock", content: "The change has a security risk. Add input validation as mitigation." };
    const report = await evaluateRunWithJudge(run, {
      id: "judge-suite", name: "Judge suite", description: "Test",
      cases: [{ id: "review-case", description: "Assess security review", agent: "code-reviewer", criteria: [{ id: "security", weight: 1, requiredTerms: ["risk"] }] }]
    }, {
      name: "stub-judge",
      async complete() {
        return { provider: "stub", model: "judge-test", content: JSON.stringify({
          score: 92, rationale: "Identifies a risk and a practical mitigation.",
          strengths: ["Names a concrete risk"], improvements: ["Add test evidence"],
          evidence: [{ quote: "The change has a security risk.", criterion: "security" }]
        }) };
      }
    });
    expect(report.judge.averageScore).toBe(92);
    expect(report.judge.passed).toBe(true);
    expect(report.judgedCases[0]?.result.evidence[0]?.quote).toBe("The change has a security risk.");
  });

  it("rejects judge evidence that is not copied from candidate output", async () => {
    const run = createRun("Judge evidence", [{ id: "review", agent: "code-reviewer", title: "Review", prompt: "Review" }]);
    run.tasks[0]!.status = "completed";
    run.tasks[0]!.result = { provider: "mock", content: "No issues found." };
    await expect(evaluateRunWithJudge(run, {
      id: "evidence-suite", name: "Evidence suite", description: "Test",
      cases: [{ id: "review-case", description: "Review", agent: "code-reviewer", criteria: [{ id: "quality", weight: 1, requiredTerms: ["issues"] }] }]
    }, {
      name: "bad-judge",
      async complete() { return { provider: "stub", content: JSON.stringify({ score: 99, rationale: "Looks good", strengths: [], improvements: [], evidence: [{ quote: "There are no vulnerabilities.", criterion: "quality" }] }) }; }
    })).rejects.toThrow("cited evidence");
  });

});
