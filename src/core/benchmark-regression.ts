import { listBenchmarkMatrices, type BenchmarkMatrixReport } from "./benchmark-matrix.js";

export type RegressionStatus = "release-ready" | "warning" | "blocked" | "insufficient-history";
export interface CandidateRegression {
  candidateId: string;
  provider: string;
  model: string;
  baselineScore: number;
  currentScore: number;
  scoreDelta: number;
  baselinePassRate: number;
  currentPassRate: number;
  passRateDelta: number;
  baselineDurationMs: number;
  currentDurationMs: number;
  durationChangePercent: number;
  baselineEstimatedTokens: number;
  currentEstimatedTokens: number;
  tokenChangePercent: number;
  scoreStdDev: number;
  failedTrials: number;
  regressions: string[];
  warnings: string[];
}
export interface AgentRegression { candidateId: string; agent: string; baselineScore: number; currentScore: number; scoreDelta: number; baselinePassRate: number; currentPassRate: number; regressions: string[]; warnings: string[]; skillsObserved: string[]; }
export interface BenchmarkRegressionReport {
  status: RegressionStatus;
  matrixId: string;
  matrixName: string;
  suiteId: string;
  baselineAt: string;
  currentAt: string;
  candidates: CandidateRegression[];
  candidateProvenance?: Array<{ candidateId: string; configVersionId: string; fingerprint: string }>;
  agents: AgentRegression[];
  summary: string[];
}
const percentChange = (baseline: number, current: number): number =>
  baseline <= 0 ? (current > 0 ? 100 : 0) : Math.round((current - baseline) / baseline * 1000) / 10;

export function analyzeBenchmarkRegression(history: BenchmarkMatrixReport[], matrixId?: string): BenchmarkRegressionReport {
  const eligible = history.filter(item => (!matrixId || item.matrixId === matrixId) && item.summary.length > 0)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (eligible.length < 2) {
    const latest = eligible.at(-1);
    return { status: "insufficient-history", matrixId: latest?.matrixId ?? matrixId ?? "unknown", matrixName: latest?.matrixName ?? "Benchmark history", suiteId: latest?.suiteId ?? "", baselineAt: "", currentAt: latest?.createdAt ?? "", candidates: [], agents: [], summary: ["A second comparable matrix run is required before regression analysis is available."] };
  }
  const current = eligible[eligible.length - 1]!;
  const previous = [...eligible.slice(0, -1)].reverse().find(item => item.suiteId === current.suiteId && item.goal === current.goal);
  if (!previous) return { status: "insufficient-history", matrixId: current.matrixId, matrixName: current.matrixName, suiteId: current.suiteId, baselineAt: "", currentAt: current.createdAt, candidates: [], agents: [], summary: ["No earlier run has the same evaluation suite and goal; create a comparable baseline first."] };
  const candidates: CandidateRegression[] = current.summary.flatMap(now => {
    const before = previous.summary.find(item => item.candidateId === now.candidateId && item.provider === now.provider && item.model === now.model);
    if (!before) return [];
    const regressions: string[] = [];
    const warnings: string[] = [];
    const scoreDelta = Math.round((now.averageScore - before.averageScore) * 10) / 10;
    const passRateDelta = Math.round((now.passRate - before.passRate) * 10) / 10;
    const durationChangePercent = percentChange(before.averageDurationMs, now.averageDurationMs);
    const tokenChangePercent = percentChange(before.averageEstimatedTokens, now.averageEstimatedTokens);
    if (scoreDelta <= -5) regressions.push("Average score dropped " + Math.abs(scoreDelta) + " points.");
    if (passRateDelta <= -20) regressions.push("Pass rate dropped " + Math.abs(passRateDelta) + " percentage points.");
    if (durationChangePercent >= 25) warnings.push("Average execution time increased " + durationChangePercent + "%.");
    if (tokenChangePercent >= 25) warnings.push("Estimated token use increased " + tokenChangePercent + "%.");
    if (now.scoreStdDev >= 15) warnings.push("Score variance is high (σ " + now.scoreStdDev + ").");
    const failedTrials = current.results.filter(item => item.candidateId === now.candidateId && item.status === "failed").length;
    if (failedTrials > 0) warnings.push(failedTrials + " trial(s) failed to complete.");
    return [{ candidateId: now.candidateId, provider: now.provider, model: now.model, baselineScore: before.averageScore, currentScore: now.averageScore, scoreDelta, baselinePassRate: before.passRate, currentPassRate: now.passRate, passRateDelta, baselineDurationMs: before.averageDurationMs, currentDurationMs: now.averageDurationMs, durationChangePercent, baselineEstimatedTokens: before.averageEstimatedTokens, currentEstimatedTokens: now.averageEstimatedTokens, tokenChangePercent, scoreStdDev: now.scoreStdDev, failedTrials, regressions, warnings }];
  });
  const agents: AgentRegression[] = (current.agentSummary ?? []).flatMap(now => {
    const before = (previous.agentSummary ?? []).find(item => item.candidateId === now.candidateId && item.agent === now.agent && item.provider === now.provider && item.model === now.model);
    if (!before) return [];
    const regressions: string[] = [];
    const warnings: string[] = [];
    const scoreDelta = Math.round((now.averageScore - before.averageScore) * 10) / 10;
    const passDelta = Math.round((now.passRate - before.passRate) * 10) / 10;
    if (scoreDelta <= -5) regressions.push("Agent score dropped " + Math.abs(scoreDelta) + " points.");
    if (passDelta <= -20) regressions.push("Agent pass rate dropped " + Math.abs(passDelta) + " percentage points.");
    if (now.completed < now.trials) warnings.push("Only " + now.completed + " of " + now.trials + " expected agent evaluations completed.");
    return [{ candidateId: now.candidateId, agent: now.agent, baselineScore: before.averageScore, currentScore: now.averageScore, scoreDelta, baselinePassRate: before.passRate, currentPassRate: now.passRate, regressions, warnings, skillsObserved: now.skillsObserved ?? [] }];
  });
  const agentRegressions = agents.reduce((sum, item) => sum + item.regressions.length, 0);
  const agentWarnings = agents.reduce((sum, item) => sum + item.warnings.length, 0);
  const matched = candidates.length;
  const regressions = candidates.reduce((sum, item) => sum + item.regressions.length, 0) + agentRegressions;
  const warnings = candidates.reduce((sum, item) => sum + item.warnings.length, 0) + agentWarnings;
  const unmatched = current.summary.length - matched;
  const status: RegressionStatus = matched === 0 || unmatched > 0 ? "insufficient-history" : regressions > 0 ? "blocked" : warnings > 0 ? "warning" : "release-ready";
  const summary = [
    matched + " candidate(s) compared against the previous run using the same suite and goal.",
    regressions + " quality regression(s), " + warnings + " efficiency or stability warning(s).",
    ...(unmatched ? [unmatched + " candidate(s) had no matching baseline and were excluded."] : []),
    "Thresholds: score drop ≥5 points or pass-rate drop ≥20 points blocks; time/token growth ≥25% or score σ ≥15 warns."
  ];
  return { status, matrixId: current.matrixId, matrixName: current.matrixName, suiteId: current.suiteId, baselineAt: previous.createdAt, currentAt: current.createdAt, candidates, ...(current.candidateProvenance ? { candidateProvenance: current.candidateProvenance } : {}), agents, summary: [...summary, agents.length + " per-agent scorecard(s) compared across the same candidate and model."] };
}

export async function loadBenchmarkRegression(projectPath: string, matrixId?: string): Promise<BenchmarkRegressionReport> {
  return analyzeBenchmarkRegression(await listBenchmarkMatrices(projectPath), matrixId);
}

export function formatBenchmarkRegression(report: BenchmarkRegressionReport): string {
  const lines = ["FORGE Benchmark Regression Intelligence · " + report.matrixName, "Status: " + report.status.toUpperCase(), "Suite: " + report.suiteId, ""];
  lines.push(...report.summary);
  for (const item of report.candidates) {
    lines.push("", item.candidateId + " · " + item.provider + "/" + item.model, "  Score: " + item.baselineScore + " → " + item.currentScore + " (" + (item.scoreDelta > 0 ? "+" : "") + item.scoreDelta + ")", "  Pass rate: " + item.baselinePassRate + "% → " + item.currentPassRate + "%", "  Duration: " + item.durationChangePercent + "% · estimated tokens: " + item.tokenChangePercent + "%");
    for (const issue of item.regressions) lines.push("  REGRESSION: " + issue);
    for (const issue of item.warnings) lines.push("  WARNING: " + issue);
  }
  if (report.agents.length) { lines.push("", "Per-agent regressions:"); for (const item of report.agents) { lines.push("  " + item.candidateId + " / " + item.agent + " · " + item.baselineScore + " → " + item.currentScore + " (" + (item.scoreDelta > 0 ? "+" : "") + item.scoreDelta + ") · pass " + item.baselinePassRate + "% → " + item.currentPassRate + "% · observed skills: " + (item.skillsObserved.join(", ") || "none")); for (const issue of item.regressions) lines.push("    REGRESSION: " + issue); for (const issue of item.warnings) lines.push("    WARNING: " + issue); } }
  lines.push("", "This is a trend signal, not a guarantee. Compare identical code snapshots, prompts, suite versions and runtime conditions.");
  return lines.join("\n");
}
