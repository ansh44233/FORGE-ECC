import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EvaluationReport, JudgedEvaluationReport } from "./evaluation-engine.js";
import type { ExecutionTraceDocument } from "./execution-trace.js";

export interface BenchmarkTrial {
  runId: string;
  recordedAt: string;
  suiteId: string;
  suiteName: string;
  score: number;
  judgeScore?: number;
  judgeProvider?: string;
  judgePassed?: boolean;
  passed: boolean;
  provider: string;
  models: string[];
  tasks: number;
  failures: number;
  fallbacks: number;
  retries: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  durationMs: number;
}
export interface BenchmarkGroup {
  key: string;
  provider: string;
  models: string[];
  trials: number;
  averageScore: number;
  averageJudgeScore?: number;
  judgePassRate?: number;
  bestScore: number;
  worstScore: number;
  passRate: number;
  scoreStdDev: number;
  averageDurationMs: number;
  averageEstimatedTokens: number;
  totalRetries: number;
  totalFallbacks: number;
}
export interface BenchmarkDocument {
  version: 1;
  suiteId: string;
  suiteName: string;
  updatedAt: string;
  trials: BenchmarkTrial[];
  groups: BenchmarkGroup[];
}

function summarize(trials: BenchmarkTrial[]): BenchmarkGroup[] {
  const buckets = new Map<string, BenchmarkTrial[]>();
  for (const trial of trials) {
    const key = trial.provider + " / " + trial.models.join(", ");
    const bucket = buckets.get(key) ?? [];
    bucket.push(trial);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()].map(([key, items]) => {
    const scores = items.map(item => item.score);
    const judged = items.filter((item): item is BenchmarkTrial & { judgeScore: number; judgePassed: boolean } => item.judgeScore !== undefined && item.judgePassed !== undefined);
    const average = scores.reduce((sum, value) => sum + value, 0) / scores.length;
    return {
      key, provider: items[0]!.provider, models: items[0]!.models, trials: items.length,
      averageScore: Math.round(average * 10) / 10,
      ...(judged.length ? { averageJudgeScore: Math.round(judged.reduce((sum, item) => sum + item.judgeScore, 0) / judged.length * 10) / 10, judgePassRate: Math.round(judged.filter(item => item.judgePassed).length / judged.length * 1000) / 10 } : {}),
      bestScore: Math.max(...scores), worstScore: Math.min(...scores),
      passRate: Math.round(items.filter(item => item.passed).length / items.length * 1000) / 10,
      scoreStdDev: Math.round(Math.sqrt(scores.reduce((sum, value) => sum + Math.pow(value - average, 2), 0) / scores.length) * 10) / 10,
      averageDurationMs: Math.round(items.reduce((sum, item) => sum + item.durationMs, 0) / items.length),
      averageEstimatedTokens: Math.round(items.reduce((sum, item) => sum + item.estimatedInputTokens + item.estimatedOutputTokens, 0) / items.length),
      totalRetries: items.reduce((sum, item) => sum + item.retries, 0),
      totalFallbacks: items.reduce((sum, item) => sum + item.fallbacks, 0),
    };
  }).sort((a, b) => b.averageScore - a.averageScore || a.averageDurationMs - b.averageDurationMs);
}

export function createBenchmarkTrial(report: EvaluationReport | JudgedEvaluationReport, trace: ExecutionTraceDocument): BenchmarkTrial {
  if (report.runId !== trace.runId) throw new Error("Evaluation report and execution trace must belong to the same run.");
  const providers = [...new Set(trace.entries.map(entry => entry.provider))].sort();
  const models = [...new Set(trace.entries.map(entry => entry.model))].sort();
  return {
    runId: report.runId, recordedAt: new Date().toISOString(), suiteId: report.suiteId, suiteName: report.suiteName,
    score: report.score, ...("judge" in report ? { judgeScore: report.judge.averageScore, judgeProvider: report.judge.provider, judgePassed: report.judge.passed } : {}), passed: report.passed, provider: providers.join(", ") || "unknown", models,
    tasks: trace.totals.tasks, failures: trace.totals.failures, fallbacks: trace.totals.fallbacks,
    retries: trace.entries.reduce((sum, entry) => sum + (entry.retries ?? 0), 0),
    estimatedInputTokens: trace.totals.estimatedInputTokens, estimatedOutputTokens: trace.totals.estimatedOutputTokens,
    durationMs: trace.totals.durationMs,
  };
}

export async function recordBenchmarkTrial(projectPath: string, trial: BenchmarkTrial): Promise<BenchmarkDocument> {
  const directory = path.join(path.resolve(projectPath), ".forge", "benchmarks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, trial.suiteId + ".json");
  let trials: BenchmarkTrial[] = [];
  try {
    const previous: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (!previous || typeof previous !== "object" || (previous as BenchmarkDocument).version !== 1 || !Array.isArray((previous as BenchmarkDocument).trials)) throw new Error("Existing benchmark history is invalid.");
    trials = (previous as BenchmarkDocument).trials;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  trials = [...trials.filter(item => item.runId !== trial.runId), trial].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const document: BenchmarkDocument = { version: 1, suiteId: trial.suiteId, suiteName: trial.suiteName, updatedAt: new Date().toISOString(), trials, groups: summarize(trials) };
  const temporary = path.join(directory, "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(document, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return document;
}

export async function loadBenchmark(projectPath: string, suiteId: string): Promise<BenchmarkDocument> {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(suiteId)) throw new Error("Invalid benchmark suite identifier.");
  const file = path.join(path.resolve(projectPath), ".forge", "benchmarks", suiteId + ".json");
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || (value as BenchmarkDocument).version !== 1 || (value as BenchmarkDocument).suiteId !== suiteId || !Array.isArray((value as BenchmarkDocument).trials)) throw new Error("Stored benchmark document is invalid.");
  return value as BenchmarkDocument;
}

export async function listBenchmarks(projectPath: string): Promise<BenchmarkDocument[]> {
  const directory = path.join(path.resolve(projectPath), ".forge", "benchmarks");
  let files: string[];
  try { files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort(); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
  const documents: BenchmarkDocument[] = [];
  for (const file of files.slice(0, 100)) {
    const id = file.slice(0, -5);
    documents.push(await loadBenchmark(projectPath, id));
  }
  return documents;
}

export function formatBenchmark(document: BenchmarkDocument): string {
  const lines = ["FORGE Benchmark Lab · " + document.suiteName, "Trials: " + document.trials.length, "", "Provider / model | Trials | Avg rubric | Avg judge | Pass rate | Variance | Avg time | Avg tokens"];
  for (const group of document.groups) lines.push([group.key, group.trials, group.averageScore + "/100", group.averageJudgeScore === undefined ? "—" : group.averageJudgeScore + "/100 (" + group.judgePassRate + "% pass)", group.passRate + "%", "σ " + group.scoreStdDev, group.averageDurationMs + " ms", group.averageEstimatedTokens].join(" | "));
  lines.push("", "Recent trials:");
  for (const trial of document.trials.slice(-10).reverse()) lines.push("  " + trial.runId + " · " + trial.provider + " / " + (trial.models.join(", ") || "unknown") + " · " + trial.score + "/100 rubric" + (trial.judgeScore === undefined ? "" : " · " + trial.judgeScore + "/100 judge") + " · " + (trial.passed ? "PASS" : "REVIEW"));
  lines.push("", "Token counts are estimates, not provider-billed usage. Benchmarks compare recorded runs; they do not automatically rerun tasks.");
  return lines.join("\n");
}
