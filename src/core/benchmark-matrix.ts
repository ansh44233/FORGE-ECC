import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

export interface BenchmarkCandidate {
  id: string;
  provider: "openai" | "claude-code" | "anthropic" | "google" | "ollama";
  model: string;
  /** undefined = normal auto-selection; [] = no skills; ids = force this skill set. */
  skillIds?: string[];
  /** Immutable workspace configuration snapshot used for this candidate. */
  configVersionId?: string;
}
export interface BenchmarkMatrixConfig {
  id: string;
  name: string;
  repeats: number;
  candidates: BenchmarkCandidate[];
  skillExperiment?: { baselineCandidateId: string; treatmentCandidateId: string; skillIds: string[] };
}
export interface AgentBenchmarkScore { agent: string; caseId: string; score: number; passed: boolean; skillIds: string[]; failedCriteria?: Array<{ id: string; failedChecks: string[] }>; }
export interface AgentBenchmarkSummary { candidateId: string; provider: string; model: string; agent: string; trials: number; completed: number; averageScore: number; passRate: number; skillsObserved: string[]; }
export interface BenchmarkMatrixResult {
  candidateId: string;
  provider: string;
  model: string;
  repeat: number;
  runId: string;
  score: number;
  passed: boolean;
  durationMs: number;
  estimatedTokens: number;
  agentScores?: AgentBenchmarkScore[];
  status: "completed" | "failed";
  error?: string;
}
export interface BenchmarkMatrixReport {
  version: 1;
  matrixId: string;
  matrixName: string;
  suiteId: string;
  goal: string;
  createdAt: string;
  candidateProvenance?: Array<{ candidateId: string; configVersionId: string; fingerprint: string }>;
  experimentManifest?: { id: string; fingerprint: string };
  results: BenchmarkMatrixResult[];
  agentSummary?: AgentBenchmarkSummary[];
  skillExperiment?: { baselineCandidateId: string; treatmentCandidateId: string; skillIds: string[]; baselineScore: number; treatmentScore: number; scoreDelta: number; baselinePassRate: number; treatmentPassRate: number; passRateDelta: number; baselineDurationMs: number; treatmentDurationMs: number; durationChangePercent: number; baselineEstimatedTokens: number; treatmentEstimatedTokens: number; tokenChangePercent: number; agentDeltas: Array<{ agent: string; baselineScore: number; treatmentScore: number; scoreDelta: number; baselinePassRate: number; treatmentPassRate: number; passRateDelta: number }> };
  summary: Array<{
    candidateId: string;
    provider: string;
    model: string;
    trials: number;
    completed: number;
    averageScore: number;
    passRate: number;
    scoreStdDev: number;
    averageDurationMs: number;
    averageEstimatedTokens: number;
  }>;
}

const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;

export function validateBenchmarkMatrix(value: unknown): BenchmarkMatrixConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Benchmark matrix config must be a JSON object.");
  const config = value as BenchmarkMatrixConfig;
  if (!SAFE_ID.test(config.id) || typeof config.name !== "string" || !config.name.trim() || config.name.length > 120) throw new Error("Benchmark matrix needs a valid id and name.");
  if (!Number.isSafeInteger(config.repeats) || config.repeats < 1 || config.repeats > 3) throw new Error("Benchmark matrix repeats must be between 1 and 3.");
  if (!Array.isArray(config.candidates) || config.candidates.length < 2 || config.candidates.length > 4) throw new Error("Benchmark matrix needs between 2 and 4 candidates.");
  const ids = new Set<string>();
  for (const candidate of config.candidates) {
    if (!candidate || !SAFE_ID.test(candidate.id) || ids.has(candidate.id)) throw new Error("Every benchmark candidate needs a unique valid id.");
    ids.add(candidate.id);
    if (!["openai", "claude-code", "anthropic", "google", "ollama"].includes(candidate.provider)) throw new Error("Unsupported benchmark candidate provider.");
    if (typeof candidate.model !== "string" || !candidate.model.trim() || candidate.model.length > 160) throw new Error("Every benchmark candidate needs a model name.");
    if (candidate.configVersionId !== undefined && !/^cfg-[a-f0-9]{12}$/.test(candidate.configVersionId)) throw new Error("Candidate configVersionId must be a valid agent configuration snapshot ID.");
  }
  for (const candidate of config.candidates) {
    if (candidate.skillIds !== undefined && (!Array.isArray(candidate.skillIds) || candidate.skillIds.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) || new Set(candidate.skillIds).size !== candidate.skillIds.length)) throw new Error("Candidate skillIds must be unique valid skill IDs.");
  }
  if (config.skillExperiment) {
    const experiment = config.skillExperiment;
    const baseline = config.candidates.find(item => item.id === experiment.baselineCandidateId);
    const treatment = config.candidates.find(item => item.id === experiment.treatmentCandidateId);
    if (!baseline || !treatment || baseline.id === treatment.id) throw new Error("Skill experiment must reference distinct baseline and treatment candidates.");
    if (baseline.provider !== treatment.provider || baseline.model !== treatment.model) throw new Error("Skill experiment candidates must use the same provider and model.");
    if (!Array.isArray(experiment.skillIds) || !experiment.skillIds.length || experiment.skillIds.some(id => typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) || new Set(experiment.skillIds).size !== experiment.skillIds.length) throw new Error("Skill experiment must specify unique valid skill IDs.");
    if (!Array.isArray(baseline.skillIds) || baseline.skillIds.length !== 0 || !Array.isArray(treatment.skillIds) || [...treatment.skillIds].sort().join(",") !== [...experiment.skillIds].sort().join(",")) throw new Error("Baseline must set skillIds to [] and treatment skillIds must exactly match skillExperiment.skillIds.");
  }
  return config;
}

export function fingerprintAgentConfig(files: Array<{ path: string; sha256: string }>): string {
  const canonical = [...files].sort((a,b) => a.path.localeCompare(b.path))
    .map(file => file.path + ":" + file.sha256).join("\\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function loadBenchmarkMatrix(file: string): Promise<BenchmarkMatrixConfig> {
  return validateBenchmarkMatrix(JSON.parse(await readFile(file, "utf8")));
}

export async function executeBenchmarkMatrix(
  config: BenchmarkMatrixConfig,
  execute: (candidate: BenchmarkCandidate, repeat: number) => Promise<Omit<BenchmarkMatrixResult, "candidateId" | "provider" | "model" | "repeat" | "status">>,
): Promise<BenchmarkMatrixReport> {
  config = validateBenchmarkMatrix(config);
  const results: BenchmarkMatrixResult[] = [];
  for (const candidate of config.candidates) {
    for (let repeat = 1; repeat <= config.repeats; repeat += 1) {
      try {
        const result = await execute(candidate, repeat);
        results.push({ candidateId: candidate.id, provider: candidate.provider, model: candidate.model, repeat, status: "completed", ...result });
      } catch (error) {
        results.push({ candidateId: candidate.id, provider: candidate.provider, model: candidate.model, repeat, runId: "", score: 0, passed: false, durationMs: 0, estimatedTokens: 0, status: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const summary = config.candidates.map(candidate => {
    const items = results.filter(item => item.candidateId === candidate.id && item.status === "completed");
    const scores = items.map(item => item.score);
    const average = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    return {
      candidateId: candidate.id, provider: candidate.provider, model: candidate.model, trials: config.repeats,
      completed: items.length,
      averageScore: Math.round(average * 10) / 10,
      passRate: items.length ? Math.round(items.filter(item => item.passed).length / items.length * 1000) / 10 : 0,
      scoreStdDev: items.length ? Math.round(Math.sqrt(scores.reduce((sum, score) => sum + Math.pow(score - average, 2), 0) / scores.length) * 10) / 10 : 0,
      averageDurationMs: items.length ? Math.round(items.reduce((sum, item) => sum + item.durationMs, 0) / items.length) : 0,
      averageEstimatedTokens: items.length ? Math.round(items.reduce((sum, item) => sum + item.estimatedTokens, 0) / items.length) : 0,
    };
  }).sort((a, b) => b.averageScore - a.averageScore || a.averageDurationMs - b.averageDurationMs);
  const agentKeys = new Set(results.flatMap(item => (item.agentScores ?? []).map(score => item.candidateId + "::" + score.agent)));
  const agentSummary = [...agentKeys].map(key => {
    const separator = key.indexOf("::");
    const candidateId = key.slice(0, separator);
    const agent = key.slice(separator + 2);
    const candidate = config.candidates.find(item => item.id === candidateId)!;
    const scores = results.filter(item => item.candidateId === candidateId && item.status === "completed").flatMap(item => (item.agentScores ?? []).filter(score => score.agent === agent));
    const skillsObserved = [...new Set(scores.flatMap(item => item.skillIds))].sort();
    return { candidateId, provider: candidate.provider, model: candidate.model, agent, trials: config.repeats, completed: scores.length, averageScore: scores.length ? Math.round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length * 10) / 10 : 0, passRate: scores.length ? Math.round(scores.filter(item => item.passed).length / scores.length * 1000) / 10 : 0, skillsObserved };
  }).sort((a, b) => b.averageScore - a.averageScore || a.agent.localeCompare(b.agent));
  let skillExperiment: BenchmarkMatrixReport["skillExperiment"];
  if (config.skillExperiment) {
    const { baselineCandidateId, treatmentCandidateId, skillIds } = config.skillExperiment;
    const baseline = summary.find(item => item.candidateId === baselineCandidateId);
    const treatment = summary.find(item => item.candidateId === treatmentCandidateId);
    if (baseline && treatment && baseline.completed > 0 && treatment.completed > 0) {
      const change = (before: number, after: number) => before <= 0 ? (after > 0 ? 100 : 0) : Math.round((after - before) / before * 1000) / 10;
      const agentDeltas = (agentSummary.filter(item => item.candidateId === baselineCandidateId)).flatMap(before => {
        const after = agentSummary.find(item => item.candidateId === treatmentCandidateId && item.agent === before.agent);
        return after ? [{ agent: before.agent, baselineScore: before.averageScore, treatmentScore: after.averageScore, scoreDelta: Math.round((after.averageScore - before.averageScore) * 10) / 10, baselinePassRate: before.passRate, treatmentPassRate: after.passRate, passRateDelta: Math.round((after.passRate - before.passRate) * 10) / 10 }] : [];
      });
      skillExperiment = { baselineCandidateId, treatmentCandidateId, skillIds: [...skillIds], baselineScore: baseline.averageScore, treatmentScore: treatment.averageScore, scoreDelta: Math.round((treatment.averageScore - baseline.averageScore) * 10) / 10, baselinePassRate: baseline.passRate, treatmentPassRate: treatment.passRate, passRateDelta: Math.round((treatment.passRate - baseline.passRate) * 10) / 10, baselineDurationMs: baseline.averageDurationMs, treatmentDurationMs: treatment.averageDurationMs, durationChangePercent: change(baseline.averageDurationMs, treatment.averageDurationMs), baselineEstimatedTokens: baseline.averageEstimatedTokens, treatmentEstimatedTokens: treatment.averageEstimatedTokens, tokenChangePercent: change(baseline.averageEstimatedTokens, treatment.averageEstimatedTokens), agentDeltas };
    }
  }
  return { version: 1, matrixId: config.id, matrixName: config.name, suiteId: "", goal: "", createdAt: new Date().toISOString(), results, summary, agentSummary, ...(config.candidates.some(candidate => candidate.configVersionId) ? { candidateProvenance: config.candidates.filter(candidate => candidate.configVersionId).map(candidate => ({ candidateId: candidate.id, configVersionId: candidate.configVersionId!, fingerprint: "" })) } : {}), ...(skillExperiment ? { skillExperiment } : {}) };
}

export async function saveBenchmarkMatrix(projectPath: string, report: BenchmarkMatrixReport): Promise<string> {
  const directory = path.join(path.resolve(projectPath), ".forge", "benchmark-matrices");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, report.matrixId + "-" + report.createdAt.replace(/[:.]/g, "-") + ".json");
  const temporary = path.join(directory, "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
  return destination;
}

export function formatBenchmarkMatrix(report: BenchmarkMatrixReport): string {
  const lines = ["FORGE Automated Benchmark Matrix · " + report.matrixName, "Suite: " + report.suiteId, "Goal: " + report.goal, "", "Candidate | Trials | Completed | Avg score | Pass rate | σ score | Avg time | Avg estimated tokens"];
  for (const item of report.summary) lines.push([item.candidateId + " (" + item.provider + "/" + item.model + ")", item.trials, item.completed, item.averageScore + "/100", item.passRate + "%", item.scoreStdDev, item.averageDurationMs + " ms", item.averageEstimatedTokens].join(" | "));
  if (report.agentSummary?.length) { lines.push("", "Per-agent scorecards:", "Candidate | Agent | Cases | Average score | Pass rate | Skills observed"); for (const item of report.agentSummary) lines.push([item.candidateId, item.agent, item.completed, item.averageScore + "/100", item.passRate + "%", item.skillsObserved.join(", ") || "none"].join(" | ")); }
  if (report.skillExperiment) {
    const item = report.skillExperiment;
    lines.push("", "Controlled skill experiment:", "  Baseline: " + item.baselineCandidateId + " (no skills)", "  Treatment: " + item.treatmentCandidateId + " (skills: " + item.skillIds.join(", ") + ")", "  Score: " + item.baselineScore + " → " + item.treatmentScore + " (" + (item.scoreDelta > 0 ? "+" : "") + item.scoreDelta + ")", "  Pass rate: " + item.baselinePassRate + "% → " + item.treatmentPassRate + "% (" + (item.passRateDelta > 0 ? "+" : "") + item.passRateDelta + " pp)", "  Duration change: " + item.durationChangePercent + "% · estimated token change: " + item.tokenChangePercent + "%");
    for (const agent of item.agentDeltas) lines.push("  Agent " + agent.agent + ": " + agent.baselineScore + " → " + agent.treatmentScore + " (" + (agent.scoreDelta > 0 ? "+" : "") + agent.scoreDelta + ")");
  }
  lines.push("", "Trial details:");
  for (const item of report.results) lines.push("  " + item.candidateId + " #" + item.repeat + " · " + (item.status === "completed" ? item.score + "/100 · " + (item.passed ? "PASS" : "REVIEW") : "FAILED · " + item.error));
  if (report.candidateProvenance?.length) { lines.push("", "Configuration provenance:"); for (const item of report.candidateProvenance) lines.push("  " + item.candidateId + " · " + item.configVersionId + " · sha256 " + item.fingerprint); }
  lines.push("", "All model usage figures are estimates. Candidate comparisons are meaningful only when task, suite, settings and environment are held constant.");
  return lines.join("\n");
}

export async function listBenchmarkMatrices(projectPath: string): Promise<BenchmarkMatrixReport[]> {
  const directory = path.join(path.resolve(projectPath), ".forge", "benchmark-matrices");
  let files: string[];
  try { files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort(); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
  const reports: BenchmarkMatrixReport[] = [];
  for (const file of files.slice(-100)) {
    const value: unknown = JSON.parse(await readFile(path.join(directory, file), "utf8"));
    if (!value || typeof value !== "object" || (value as BenchmarkMatrixReport).version !== 1 || !Array.isArray((value as BenchmarkMatrixReport).results) || !Array.isArray((value as BenchmarkMatrixReport).summary)) throw new Error("Stored benchmark matrix report is invalid: " + file);
    reports.push(value as BenchmarkMatrixReport);
  }
  return reports.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
