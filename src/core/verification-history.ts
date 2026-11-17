import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationResult } from "./verification.js";

const HISTORY_DIR = path.join(".forge", "verifications");
const ID_PATTERN = /^verify-[a-z0-9-]{8,80}$/;

export interface VerificationComparison {
  current: VerificationResult;
  previous: VerificationResult | null;
  change: "baseline" | "regression" | "improvement" | "unchanged";
}

function historyPath(projectPath: string): string {
  return path.join(path.resolve(projectPath), HISTORY_DIR);
}

export async function saveVerification(projectPath: string, result: VerificationResult): Promise<string> {
  if (!ID_PATTERN.test(result.id)) throw new Error("Invalid verification result identifier.");
  const directory = historyPath(projectPath);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, result.id + ".json");
  await writeFile(file, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return file;
}

export async function listVerifications(projectPath: string, limit = 50): Promise<VerificationResult[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("History limit must be between 1 and 500.");
  const directory = historyPath(projectPath);
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const results: VerificationResult[] = [];
  for (const name of names.filter(item => ID_PATTERN.test(item.replace(/\.json$/, "")) && item.endsWith(".json"))) {
    try {
      const value: unknown = JSON.parse(await readFile(path.join(directory, name), "utf8"));
      if (isVerificationResult(value)) results.push(value);
    } catch { /* Ignore malformed history entries; never execute or repair them. */ }
  }
  return results.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

function isVerificationResult(value: unknown): value is VerificationResult {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<VerificationResult>;
  return typeof item.id === "string" && ID_PATTERN.test(item.id) &&
    typeof item.script === "string" && typeof item.startedAt === "string" &&
    ["passed", "failed", "timed_out", "spawn_error"].includes(item.status ?? "") &&
    typeof item.durationMs === "number" && typeof item.output === "string";
}

export async function compareVerification(projectPath: string, current: VerificationResult): Promise<VerificationComparison> {
  const history = await listVerifications(projectPath, 500);
  const previous = history.find(item => item.script === current.script && item.id !== current.id) ?? null;
  if (!previous) return { current, previous: null, change: "baseline" };
  const currentPassed = current.status === "passed";
  const previousPassed = previous.status === "passed";
  const change = currentPassed && !previousPassed ? "improvement" : !currentPassed && previousPassed ? "regression" : "unchanged";
  return { current, previous, change };
}

export function formatVerificationComparison(comparison: VerificationComparison): string {
  if (!comparison.previous) return "Comparison: BASELINE — no earlier run exists for this script.";
  return [
    "## Previous run comparison",
    "- Previous: " + comparison.previous.status.toUpperCase() + " (" + comparison.previous.id + ")",
    "- Current: " + comparison.current.status.toUpperCase() + " (" + comparison.current.id + ")",
    "- Result: " + comparison.change.toUpperCase(),
    "- Duration: " + comparison.previous.durationMs + " ms → " + comparison.current.durationMs + " ms"
  ].join("\n");
}