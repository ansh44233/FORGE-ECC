import { describe, expect, it } from "vitest";
import { buildAgentOptimizationPlan, formatAgentOptimizationPlan } from "../src/core/agent-optimization.js";
import type { BenchmarkMatrixReport } from "../src/core/benchmark-matrix.js";
function matrix(createdAt: string, score: number, failedCriteria: Array<{id:string;failedChecks:string[]}> = []): BenchmarkMatrixReport {
  return { version:1, matrixId:"same-matrix", matrixName:"Agent quality", suiteId:"engineering-basics", goal:"Review auth", createdAt,
    results:[{candidateId:"candidate-a",provider:"openai",model:"test-model",repeat:1,runId:"run",score,passed:false,durationMs:100,estimatedTokens:100,status:"completed",agentScores:[{agent:"security-reviewer",caseId:"auth",score,passed:false,skillIds:["secure-changes"],failedCriteria}]}],
    summary:[{candidateId:"candidate-a",provider:"openai",model:"test-model",trials:1,completed:1,averageScore:score,passRate:0,scoreStdDev:0,averageDurationMs:100,averageEstimatedTokens:100}],
    agentSummary:[{candidateId:"candidate-a",provider:"openai",model:"test-model",agent:"security-reviewer",trials:1,completed:1,averageScore:score,passRate:0,skillsObserved:["secure-changes"]}] };
}
describe("adaptive agent optimization",()=>{
  it("identifies repeated failed criteria and suggests review without changing configuration",()=>{
    const plan=buildAgentOptimizationPlan([
      matrix("2026-11-15T10:00:00.000Z",90),
      matrix("2026-11-16T10:00:00.000Z",70,[{id:"evidence",failedChecks:["required-term: evidence"]},{id:"evidence",failedChecks:["required-term: evidence"]}])
    ]);
    expect(plan.status).toBe("recommendations");
    expect(plan.suggestions[0]?.agent).toBe("security-reviewer");
    expect(plan.suggestions[0]?.repeatedFailures[0]).toMatchObject({criterionId:"evidence",count:2});
    expect(plan.suggestions[0]?.recommendedActions.join(" ")).toContain("verification checklist");
    expect(plan.guardrails.join(" ")).toContain("does not rewrite");
    expect(formatAgentOptimizationPlan(plan)).toContain("RECOMMEND:");
  });
  it("requires comparable history before making recommendations",()=>{
    expect(buildAgentOptimizationPlan([matrix("2026-11-16T10:00:00.000Z",70)]).status).toBe("insufficient-history");
  });
});
