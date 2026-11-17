import { describe, expect, it } from "vitest";
import { buildExperimentHistory, formatExperimentHistory } from "../src/core/experiment-history.js";
import type { BenchmarkMatrixReport } from "../src/core/benchmark-matrix.js";
function report(matrixId: string, createdAt: string, candidateId: string, score: number, passRate: number): BenchmarkMatrixReport {
  return {
    version:1,matrixId,matrixName:matrixId,suiteId:"suite-a",goal:"same goal",createdAt,
    results:[{candidateId,provider:"openai",model:"model-a",repeat:1,runId:matrixId,score,passed:passRate===100,durationMs:1000,estimatedTokens:400,status:"completed"}],
    summary:[{candidateId,provider:"openai",model:"model-a",trials:1,completed:1,averageScore:score,passRate,scoreStdDev:0,averageDurationMs:1000,averageEstimatedTokens:400}]
  };
}
describe("experiment history leaderboard",()=>{
  it("ranks candidates, aggregates history and flags score regressions",()=>{
    const history=[report("m1","2026-01-01T00:00:00.000Z","alpha",90,100),report("m2","2026-01-02T00:00:00.000Z","alpha",82,80),report("m3","2026-01-03T00:00:00.000Z","beta",88,100)];
    const result=buildExperimentHistory(history);
    expect(result.reportsAnalyzed).toBe(3);
    expect(result.entries[0]?.candidateId).toBe("beta");
    const alpha=result.entries.find(item=>item.candidateId==="alpha")!;
    expect(alpha.averageScore).toBe(86);
    expect(alpha.scoreDelta).toBe(-8);
    expect(alpha.regression).toBe(true);
    expect(result.regressions[0]).toContain("alpha");
    expect(formatExperimentHistory(result)).toContain("Regression signals");
  });
  it("filters suite and candidate and handles a first-ever run",()=>{
    const result=buildExperimentHistory([report("m1","2026-01-01T00:00:00.000Z","alpha",90,100)],{suiteId:"suite-a",candidateId:"alpha"});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.scoreDelta).toBeNull();
    expect(buildExperimentHistory([]).entries).toEqual([]);
  });
});
