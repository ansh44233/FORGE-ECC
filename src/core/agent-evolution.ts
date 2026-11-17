import type { BenchmarkMatrixReport } from "./benchmark-matrix.js";

export interface AgentEvolutionAssessment {
  status: "eligible-for-review" | "hold" | "reject" | "insufficient-evidence";
  matrixId: string;
  baselineCandidateId: string;
  treatmentCandidateId: string;
  scoreDelta: number;
  passRateDelta: number;
  durationChangePercent: number;
  tokenChangePercent: number;
  candidateConfigPinned: boolean;
  checks: Array<{ name: string; status: "pass" | "warning" | "fail"; detail: string }>;
  rationale: string[];
}
export function assessAgentEvolution(report: BenchmarkMatrixReport): AgentEvolutionAssessment {
  const experiment = report.skillExperiment;
  if (!experiment) throw new Error("This benchmark report has no controlled skill experiment. Configure skillExperiment with baseline and treatment candidates.");
  const baseline = report.summary.find(item => item.candidateId === experiment.baselineCandidateId);
  const treatment = report.summary.find(item => item.candidateId === experiment.treatmentCandidateId);
  if (!baseline || !treatment || baseline.completed < 2 || treatment.completed < 2) {
    return { status: "insufficient-evidence", matrixId: report.matrixId, baselineCandidateId: experiment.baselineCandidateId, treatmentCandidateId: experiment.treatmentCandidateId, scoreDelta: experiment.scoreDelta, passRateDelta: experiment.passRateDelta, durationChangePercent: experiment.durationChangePercent, tokenChangePercent: experiment.tokenChangePercent, candidateConfigPinned: false, checks: [{ name: "Repeat count", status: "fail", detail: "At least two completed trials per candidate are required." }], rationale: ["Collect more controlled trials before evaluating this change."] };
  }
  const provenance = report.candidateProvenance?.find(item => item.candidateId === experiment.treatmentCandidateId);
  const agentRegressions = experiment.agentDeltas.filter(item => item.scoreDelta <= -5 || item.passRateDelta <= -20);
  const failedTrials = report.results.filter(item => item.candidateId === experiment.treatmentCandidateId && item.status === "failed").length;
  const checks: AgentEvolutionAssessment["checks"] = [
    { name: "Repeat count", status: "pass", detail: baseline.completed + " baseline and " + treatment.completed + " treatment trials completed." },
    { name: "Overall score", status: experiment.scoreDelta > 0 ? "pass" : experiment.scoreDelta === 0 ? "warning" : "fail", detail: "Treatment score delta: " + experiment.scoreDelta + " points." },
    { name: "Pass rate", status: experiment.passRateDelta >= 0 ? "pass" : "fail", detail: "Treatment pass-rate delta: " + experiment.passRateDelta + " percentage points." },
    { name: "Per-agent regressions", status: agentRegressions.length ? "fail" : "pass", detail: agentRegressions.length ? agentRegressions.map(item => item.agent + " (" + item.scoreDelta + " score, " + item.passRateDelta + " pass-rate points)").join("; ") : "No agent crossed the configured regression thresholds." },
    { name: "Treatment failures", status: failedTrials ? "warning" : "pass", detail: failedTrials + " failed treatment trial(s)." },
    { name: "Configuration provenance", status: provenance ? "pass" : "warning", detail: provenance ? provenance.configVersionId + " · sha256 " + provenance.fingerprint : "No pinned treatment configuration snapshot; reproducibility is incomplete." },
    { name: "Efficiency", status: experiment.durationChangePercent >= 25 || experiment.tokenChangePercent >= 25 ? "warning" : "pass", detail: "Duration change " + experiment.durationChangePercent + "%; estimated token change " + experiment.tokenChangePercent + "%." }
  ];
  const failed = checks.some(item => item.status === "fail");
  const warning = checks.some(item => item.status === "warning");
  const status = failed ? "reject" : warning ? "hold" : "eligible-for-review";
  const rationale = status === "eligible-for-review"
    ? ["The treatment improved quality without crossing per-agent regression or efficiency warning thresholds.", "Eligible for human review only; this assessment does not approve or activate the configuration."]
    : status === "reject"
      ? ["The treatment failed one or more quality gates. Do not promote this candidate.", "Inspect failed criteria and agent-level deltas, then revise and rerun the controlled experiment."]
      : ["The treatment has unresolved evidence or efficiency warnings.", "Resolve warnings, pin the treatment snapshot and rerun before requesting release approval."];
  return { status, matrixId: report.matrixId, baselineCandidateId: experiment.baselineCandidateId, treatmentCandidateId: experiment.treatmentCandidateId, scoreDelta: experiment.scoreDelta, passRateDelta: experiment.passRateDelta, durationChangePercent: experiment.durationChangePercent, tokenChangePercent: experiment.tokenChangePercent, candidateConfigPinned: Boolean(provenance), checks, rationale };
}
export function formatAgentEvolutionAssessment(item: AgentEvolutionAssessment): string {
  return ["FORGE Agent Evolution Lab", "Assessment: " + item.status.toUpperCase(), "Matrix: " + item.matrixId, "Baseline: " + item.baselineCandidateId, "Treatment: " + item.treatmentCandidateId, "Score delta: " + (item.scoreDelta > 0 ? "+" : "") + item.scoreDelta, "Pass-rate delta: " + (item.passRateDelta > 0 ? "+" : "") + item.passRateDelta + " points", "Duration change: " + item.durationChangePercent + "% · estimated token change: " + item.tokenChangePercent + "%", "Pinned config: " + (item.candidateConfigPinned ? "yes" : "no"), "", "Quality gates:", ...item.checks.map(check => "  " + check.status.toUpperCase() + " · " + check.name + ": " + check.detail), "", "Decision notes:", ...item.rationale.map(line => "  - " + line)].join("\n");
}
