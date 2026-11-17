import type { BenchmarkMatrixReport } from "./benchmark-matrix.js";

export interface ExperimentLeaderboardEntry {
  suiteId: string;
  candidateId: string;
  provider: string;
  model: string;
  runs: number;
  completedTrials: number;
  averageScore: number;
  passRate: number;
  averageDurationMs: number;
  averageEstimatedTokens: number;
  scoreStdDev: number;
  latestScore: number;
  scoreDelta: number | null;
  latestMatrixId: string;
  regression: boolean;
}
export interface ExperimentHistoryReport {
  generatedAt: string;
  reportsAnalyzed: number;
  entries: ExperimentLeaderboardEntry[];
  regressions: string[];
  caveats: string[];
}
export function buildExperimentHistory(history: BenchmarkMatrixReport[], options: { suiteId?: string; candidateId?: string; limit?: number } = {}): ExperimentHistoryReport {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const reports = history.filter(report => report.summary.length && (!options.suiteId || report.suiteId === options.suiteId))
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
  const groups = new Map<string, Array<{ report: BenchmarkMatrixReport; summary: BenchmarkMatrixReport["summary"][number] }>>();
  for (const report of reports) for (const summary of report.summary) {
    if (options.candidateId && summary.candidateId !== options.candidateId) continue;
    const key = report.suiteId + "::" + summary.candidateId + "::" + summary.provider + "::" + summary.model;
    const values = groups.get(key) ?? [];
    values.push({ report, summary });
    groups.set(key, values);
  }
  const entries: ExperimentLeaderboardEntry[] = [];
  for (const values of groups.values()) {
    const latest = values[values.length - 1]!;
    const previous = values.length > 1 ? values[values.length - 2] : undefined;
    const completed = values.reduce((sum,item) => sum + item.summary.completed,0);
    const weighted = (field: "averageScore" | "passRate" | "averageDurationMs" | "averageEstimatedTokens") => completed
      ? Math.round(values.reduce((sum,item) => sum + item.summary[field] * item.summary.completed,0) / completed * (field === "averageDurationMs" || field === "averageEstimatedTokens" ? 1 : 10)) / (field === "averageDurationMs" || field === "averageEstimatedTokens" ? 1 : 10)
      : 0;
    const allScores = values.flatMap(item => item.report.results.filter(result => result.candidateId === latest.summary.candidateId && result.status === "completed").map(result => result.score));
    const average = allScores.length ? allScores.reduce((sum,value)=>sum+value,0)/allScores.length : 0;
    const stdDev = allScores.length ? Math.sqrt(allScores.reduce((sum,value)=>sum+Math.pow(value-average,2),0)/allScores.length) : 0;
    const scoreDelta = previous ? Math.round((latest.summary.averageScore - previous.summary.averageScore)*10)/10 : null;
    entries.push({
      suiteId: latest.report.suiteId,candidateId:latest.summary.candidateId,provider:latest.summary.provider,model:latest.summary.model,
      runs:values.length,completedTrials:completed,averageScore:weighted("averageScore"),passRate:weighted("passRate"),
      averageDurationMs:weighted("averageDurationMs"),averageEstimatedTokens:weighted("averageEstimatedTokens"),
      scoreStdDev:Math.round(stdDev*10)/10,latestScore:latest.summary.averageScore,scoreDelta,latestMatrixId:latest.report.matrixId,
      regression:scoreDelta !== null && scoreDelta <= -5
    });
  }
  entries.sort((a,b)=>a.suiteId.localeCompare(b.suiteId)||b.averageScore-a.averageScore||a.candidateId.localeCompare(b.candidateId));
  const regressions=entries.filter(item=>item.regression).map(item=>item.suiteId+" / "+item.candidateId+": latest score fell "+Math.abs(item.scoreDelta ?? 0)+" points versus its previous run.");
  return {
    generatedAt:new Date().toISOString(),reportsAnalyzed:reports.length,entries,regressions,
    caveats:[
      "Rankings are comparable only within the same suite and equivalent task/environment settings.",
      "Scores are weighted by completed trials; benchmark rubric quality and coverage determine what the scores mean.",
      "Token counts are estimates, not provider billing records. Historical configuration and model changes can confound trends."
    ]
  };
}
export function formatExperimentHistory(report: ExperimentHistoryReport): string {
  const lines=["FORGE Experiment History & Leaderboard","Reports analyzed: "+report.reportsAnalyzed,"","Suite | Rank | Candidate | Provider/model | Runs | Trials | Avg score | Pass rate | Avg duration | Estimated tokens | Score trend"];
  let suite="";let rank=0;
  for(const item of report.entries){
    if(item.suiteId!==suite){suite=item.suiteId;rank=0;lines.push("",suite+" leaderboard");}
    rank+=1;
    lines.push([item.suiteId,String(rank),item.candidateId,item.provider+"/"+item.model,item.runs,item.completedTrials,item.averageScore+"/100",item.passRate+"%",item.averageDurationMs+" ms",item.averageEstimatedTokens,item.scoreDelta===null?"new":(item.scoreDelta>0?"+":"")+item.scoreDelta].join(" | "));
  }
  lines.push("","Regression signals:");
  lines.push(...(report.regressions.length?report.regressions.map(item=>"  - "+item):["  No score drops of 5 points or more detected."]));
  lines.push("","Caveats:",...report.caveats.map(item=>"  - "+item));
  return lines.join("\n");
}
