import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { analyzeEngineeringRisk, type EngineeringRiskReport } from "./engineering-risk.js";

const exec = promisify(execFile);
const HISTORY_DIR = path.join(".forge", "intelligence");
const MAX_SNAPSHOTS = 100;
const ID = /^intel-[a-f0-9-]{20,40}$/;
export interface IntelligenceSnapshot {
  id: string;
  generatedAt: string;
  commit: string | null;
  metrics: { score: number; high: number; elevated: number; moderate: number; hotspots: number; scannedFiles: number; relationships: number; qualityFindings: number; severeQualityFindings: number };
  topHotspots: Array<{ file: string; score: number; level: string }>;
}
export interface IntelligenceComparison {
  current: IntelligenceSnapshot;
  previous: IntelligenceSnapshot | null;
  delta: { score: number; high: number; elevated: number; moderate: number; hotspots: number; qualityFindings: number } | null;
  newHotspots: string[];
  resolvedHotspots: string[];
  trend: "baseline" | "improved" | "regressed" | "unchanged";
}
function directory(root: string): string { return path.join(path.resolve(root), HISTORY_DIR); }
function isSnapshot(value: unknown): value is IntelligenceSnapshot {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<IntelligenceSnapshot>;
  return typeof item.id === "string" && ID.test(item.id) && typeof item.generatedAt === "string" &&
    (item.commit === null || typeof item.commit === "string") &&
    typeof item.metrics?.score === "number" && typeof item.metrics?.high === "number" &&
    typeof item.metrics?.elevated === "number" && typeof item.metrics?.moderate === "number" &&
    typeof item.metrics?.hotspots === "number" && typeof item.metrics?.scannedFiles === "number" &&
    Array.isArray(item.topHotspots);
}
async function currentCommit(root: string): Promise<string | null> {
  try { const result = await exec("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, timeout: 3000 }); return result.stdout.trim() || null; }
  catch { return null; }
}
function makeSnapshot(report: EngineeringRiskReport, commit: string | null): IntelligenceSnapshot {
  const metrics = report.summary;
  const weighted = metrics.scannedFiles ? Math.round(
    (metrics.high * 100 + metrics.elevated * 65 + metrics.moderate * 35 + metrics.low * 10) /
    Math.max(1, metrics.hotspots)
  ) : 0;
  return {
    id: "intel-" + randomUUID(), generatedAt: new Date().toISOString(), commit,
    metrics: {
      score: Math.max(0, Math.min(100, weighted)), high: metrics.high, elevated: metrics.elevated,
      moderate: metrics.moderate, hotspots: metrics.hotspots, scannedFiles: metrics.scannedFiles,
      relationships: metrics.relationships, qualityFindings: metrics.qualityFindings,
      severeQualityFindings: metrics.severeQualityFindings
    },
    topHotspots: report.hotspots.slice(0, 10).map(item => ({ file: item.file, score: item.score, level: item.level }))
  };
}
async function loadHistory(root: string): Promise<IntelligenceSnapshot[]> {
  let entries;
  try { entries = await readdir(directory(root), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const records: IntelligenceSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || !ID.test(entry.name.slice(0, -5))) continue;
    try {
      const value: unknown = JSON.parse(await readFile(path.join(directory(root), entry.name), "utf8"));
      if (isSnapshot(value)) records.push(value);
    } catch { /* Ignore malformed local history; never execute stored content. */ }
  }
  return records.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)).slice(-MAX_SNAPSHOTS);
}
export function compareIntelligenceSnapshots(current: IntelligenceSnapshot, previous: IntelligenceSnapshot | null): IntelligenceComparison {
  if (!previous) return { current, previous: null, delta: null, newHotspots: current.topHotspots.map(item => item.file), resolvedHotspots: [], trend: "baseline" };
  const delta = {
    score: current.metrics.score - previous.metrics.score,
    high: current.metrics.high - previous.metrics.high,
    elevated: current.metrics.elevated - previous.metrics.elevated,
    moderate: current.metrics.moderate - previous.metrics.moderate,
    hotspots: current.metrics.hotspots - previous.metrics.hotspots,
    qualityFindings: current.metrics.qualityFindings - previous.metrics.qualityFindings
  };
  const oldFiles = new Set(previous.topHotspots.map(item => item.file));
  const newFiles = new Set(current.topHotspots.map(item => item.file));
  const newHotspots = [...newFiles].filter(file => !oldFiles.has(file));
  const resolvedHotspots = [...oldFiles].filter(file => !newFiles.has(file));
  const trend = delta.score < 0 || delta.high < 0 || delta.qualityFindings < 0 ? "improved" :
    delta.score > 0 || delta.high > 0 || delta.qualityFindings > 0 ? "regressed" : "unchanged";
  return { current, previous, delta, newHotspots, resolvedHotspots, trend };
}
export async function listIntelligenceSnapshots(root: string): Promise<IntelligenceSnapshot[]> {
  return loadHistory(root);
}
export async function captureIntelligenceSnapshot(root: string): Promise<IntelligenceComparison> {
  const project = path.resolve(root);
  const [report, commit] = await Promise.all([analyzeEngineeringRisk(project), currentCommit(project)]);
  const current = makeSnapshot(report, commit);
  const dir = directory(project);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, current.id + ".json");
  const temp = path.join(dir, "." + current.id + ".tmp");
  try {
    await writeFile(temp, JSON.stringify(current, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  const history = await loadHistory(project);
  const previous = history.filter(item => item.id !== current.id).at(-1) ?? null;
  // Keep the on-disk history bounded to the newest 100 valid snapshots.
  const all = history;
  const keep = new Set(all.map(item => item.id + ".json"));
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && ID.test(entry.name.replace(/\.json$/, "")) && entry.name.endsWith(".json") && !keep.has(entry.name)) {
      await rm(path.join(dir, entry.name), { force: true });
    }
  }
  return compareIntelligenceSnapshots(current, previous);
}
export async function compareLatestIntelligence(root: string): Promise<IntelligenceComparison | null> {
  const history = await loadHistory(root);
  if (!history.length) return null;
  return compareIntelligenceSnapshots(history[history.length - 1]!, history.length > 1 ? history[history.length - 2]! : null);
}
export function formatIntelligenceComparison(comparison: IntelligenceComparison): string {
  const c = comparison.current;
  const d = comparison.delta;
  const signed = (n: number) => (n > 0 ? "+" : "") + n;
  return [
    "# FORGE Engineering Intelligence Timeline", "",
    "- Captured: " + c.generatedAt,
    "- Git commit: " + (c.commit ?? "unavailable (not a Git repository)"),
    "- Structural risk index: " + c.metrics.score + "/100",
    "- Hotspots: " + c.metrics.hotspots + " (high " + c.metrics.high + ", elevated " + c.metrics.elevated + ", moderate " + c.metrics.moderate + ")",
    "- Quality findings: " + c.metrics.qualityFindings + " (" + c.metrics.severeQualityFindings + " high/critical)",
    "- Architecture: " + c.metrics.scannedFiles + " files, " + c.metrics.relationships + " relationships", "",
    "## Comparison",
    ...(d ? [
      "- Previous snapshot: " + comparison.previous!.generatedAt,
      "- Trend: " + comparison.trend.toUpperCase(),
      "- Risk index: " + signed(d.score),
      "- High hotspots: " + signed(d.high),
      "- Total hotspots: " + signed(d.hotspots),
      "- Quality findings: " + signed(d.qualityFindings),
      "- New top hotspots: " + (comparison.newHotspots.join(", ") || "none"),
      "- No-longer-top hotspots: " + (comparison.resolvedHotspots.join(", ") || "none")
    ] : ["- BASELINE: no earlier snapshot exists."]),
    "", "## Top hotspots",
    ...(c.topHotspots.length ? c.topHotspots.map(item => "- [" + item.level.toUpperCase() + " · " + item.score + "] `" + item.file + "`") : ["- No hotspots recorded."]),
    "", "## Interpretation",
    "- Trend compares saved static-analysis snapshots only; it is not a continuous monitor or a guarantee of code quality.",
    "- Risk index is an aggregate of the hotspot severity distribution. A lower value is generally preferable, but review individual modules and findings.",
    "- Snapshots are local to the analyzed project in .forge/intelligence and are not committed or uploaded by FORGE."
  ].join("\n");
}
