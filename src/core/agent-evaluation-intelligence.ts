import type { BenchmarkMatrixReport } from "./benchmark-matrix.js";

export interface AgentCaseMetric {
  caseId: string;
  evaluations: number;
  averageScore: number;
  passRate: number;
}
export interface AgentCriterionSignal {
  criterionId: string;
  failures: number;
  evaluations: number;
  failureRate: number;
}
export interface AgentEffectivenessCard {
  candidateId: string;
  provider: string;
  model: string;
  agent: string;
  evaluations: number;
  averageScore: number;
  passRate: number;
  scoreTrend: number | null;
  caseMetrics: AgentCaseMetric[];
  criterionSignals: AgentCriterionSignal[];
  strengths: string[];
  improvementAreas: string[];
  confidence: "low" | "medium" | "high";
}
export interface AgentEvaluationIntelligence {
  status: "ready" | "insufficient-data";
  suiteId: string;
  runsAnalyzed: number;
  generatedAt: string;
  cards: AgentEffectivenessCard[];
  recommendations: string[];
  caveats: string[];
}
export function buildAgentEvaluationIntelligence(history: BenchmarkMatrixReport[], options: { suiteId?: string; candidateId?: string; limit?: number } = {}): AgentEvaluationIntelligence {
  const limit = Math.max(2, Math.min(50, options.limit ?? 10));
  const eligible = history.filter(report => report.summary.length > 0 && (!options.suiteId || report.suiteId === options.suiteId))
    .sort((a,b) => a.createdAt.localeCompare(b.createdAt)).slice(-limit);
  const current = eligible.at(-1);
  const caveats = [
    "Scores reflect the configured benchmark rubric; they are not a universal measure of agent quality.",
    "Comparisons are descriptive. Different suites, prompts, models or source snapshots can confound trends.",
    "Criterion failure counts are based only on recorded failedCriteria and completed benchmark trials."
  ];
  if (!current?.agentSummary?.length) return { status: "insufficient-data", suiteId: options.suiteId ?? current?.suiteId ?? "", runsAnalyzed: eligible.length, generatedAt: new Date().toISOString(), cards: [], recommendations: ["Run benchmark-matrix at least once with per-agent score collection; repeat comparable runs to establish trends."], caveats };
  const selected = current.agentSummary.filter(item => !options.candidateId || item.candidateId === options.candidateId);
  const cards: AgentEffectivenessCard[] = selected.map(item => {
    const same = eligible.filter(report => report.matrixId === current.matrixId && report.suiteId === current.suiteId && report.goal === current.goal)
      .flatMap(report => (report.agentSummary ?? []).filter(agent => agent.candidateId === item.candidateId && agent.agent === item.agent && agent.provider === item.provider && agent.model === item.model));
    const previous = same.length > 1 ? same[same.length - 2]! : undefined;
    const scoreTrend = previous ? Math.round((item.averageScore - previous.averageScore) * 10) / 10 : null;
    const scores = eligible.filter(report => report.matrixId === current.matrixId && report.suiteId === current.suiteId && report.goal === current.goal)
      .flatMap(report => report.results.filter(result => result.candidateId === item.candidateId && result.provider === item.provider && result.model === item.model && result.status === "completed")
        .flatMap(result => (result.agentScores ?? []).filter(score => score.agent === item.agent).map(score => ({ ...score, runId: result.runId }))));
    const caseIds = [...new Set(scores.map(score => score.caseId))].sort();
    const caseMetrics = caseIds.map(caseId => {
      const values = scores.filter(score => score.caseId === caseId);
      return { caseId, evaluations: values.length, averageScore: Math.round(values.reduce((sum,value) => sum + value.score,0)/values.length*10)/10, passRate: Math.round(values.filter(value=>value.passed).length/values.length*1000)/10 };
    }).sort((a,b) => a.averageScore-b.averageScore);
    const criteria = new Map<string,{failures:number;evaluations:number}>();
    for (const score of scores) {
      for (const failed of score.failedCriteria ?? []) {
        const value = criteria.get(failed.id) ?? { failures: 0, evaluations: 0 };
        value.failures += 1; criteria.set(failed.id,value);
      }
    }
    for (const score of scores) for (const failed of score.failedCriteria ?? []) {
      const value = criteria.get(failed.id)!;
      value.evaluations = scores.length;
    }
    const criterionSignals = [...criteria.entries()].map(([criterionId,value]) => ({ criterionId, failures: value.failures, evaluations: value.evaluations, failureRate: value.evaluations ? Math.round(value.failures/value.evaluations*1000)/10 : 0 })).sort((a,b)=>b.failureRate-a.failureRate);
    const strengths = caseMetrics.filter(value => value.averageScore >= 85 && value.evaluations >= 2).map(value => value.caseId);
    const improvementAreas = [...caseMetrics.filter(value => value.averageScore < 75).map(value => "case:" + value.caseId), ...criterionSignals.filter(value => value.failureRate >= 30).map(value => "criterion:" + value.criterionId)];
    const confidence: AgentEffectivenessCard["confidence"] = scores.length >= 10 && eligible.length >= 3 ? "high" : scores.length >= 4 && eligible.length >= 2 ? "medium" : "low";
    return { candidateId:item.candidateId,provider:item.provider,model:item.model,agent:item.agent,evaluations:scores.length,averageScore:item.averageScore,passRate:item.passRate,scoreTrend,caseMetrics,criterionSignals,strengths,improvementAreas,confidence };
  }).sort((a,b)=>a.averageScore-b.averageScore || a.agent.localeCompare(b.agent));
  const recommendations = cards.flatMap(card => [
    ...(card.scoreTrend !== null && card.scoreTrend <= -5 ? [card.agent + ": investigate the recent " + Math.abs(card.scoreTrend) + "-point score decline before changing prompts."] : []),
    ...(card.improvementAreas.length ? [card.agent + ": prioritize " + card.improvementAreas.slice(0,4).join(", ") + " with targeted evaluation cases."] : []),
    ...(card.evaluations < 3 ? [card.agent + ": collect more trials; current evidence is limited."] : [])
  ]);
  return { status:"ready",suiteId:current.suiteId,runsAnalyzed:eligible.length,generatedAt:new Date().toISOString(),cards,recommendations:recommendations.length?recommendations:["No repeated weak areas detected in the analyzed benchmark evidence."],caveats };
}
export function formatAgentEvaluationIntelligence(report: AgentEvaluationIntelligence): string {
  const lines=["FORGE Agent Evaluation Intelligence","Status: "+report.status.toUpperCase(),"Suite: "+(report.suiteId||"not available"),"Runs analyzed: "+report.runsAnalyzed,""];
  for(const card of report.cards){
    lines.push(card.agent+" · "+card.candidateId+" · "+card.provider+"/"+card.model,"  Effectiveness: "+card.averageScore+"/100 · pass rate "+card.passRate+"% · evaluations "+card.evaluations+" · confidence "+card.confidence,"  Trend: "+(card.scoreTrend===null?"not enough comparable history":(card.scoreTrend>0?"+":"")+card.scoreTrend+" points"));
    if(card.strengths.length) lines.push("  Strengths: "+card.strengths.join(", "));
    if(card.caseMetrics.length) lines.push("  Case scores: "+card.caseMetrics.map(item=>item.caseId+" "+item.averageScore+"/100 ("+item.passRate+"% pass)").join(" · "));
    if(card.criterionSignals.length) lines.push("  Failure signals: "+card.criterionSignals.slice(0,5).map(item=>item.criterionId+" "+item.failureRate+"% ("+item.failures+"/"+item.evaluations+")").join(" · "));
    if(card.improvementAreas.length) lines.push("  Focus: "+card.improvementAreas.join(", "));
  }
  lines.push("","Recommendations:",...report.recommendations.map(item=>"  - "+item),"","Caveats:",...report.caveats.map(item=>"  - "+item));
  return lines.join("\n");
}
