import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentTrace } from "./model-router.js";

export interface ExecutionTraceDocument {
  version: 1;
  runId: string;
  createdAt: string;
  entries: AgentTrace[];
  totals: { tasks: number; successes: number; fallbacks: number; failures: number; estimatedInputTokens: number; estimatedOutputTokens: number; durationMs: number };
  providers: Array<{ name: string; requests: number; successes: number; fallbacks: number; failures: number; retries: number; durationMs: number }>;
}

function isValidTraceEntry(value: unknown): value is AgentTrace {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.taskId === "string" && entry.taskId.length > 0 && entry.taskId.length <= 160 &&
    typeof entry.agent === "string" && entry.agent.length > 0 && entry.agent.length <= 120 &&
    (entry.tier === "fast" || entry.tier === "balanced" || entry.tier === "reasoning") &&
    typeof entry.model === "string" && entry.model.length > 0 && entry.model.length <= 200 &&
    typeof entry.provider === "string" && entry.provider.length > 0 && entry.provider.length <= 120 &&
    typeof entry.startedAt === "string" && Number.isFinite(Date.parse(entry.startedAt)) &&
    typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0 &&
    (entry.outcome === "success" || entry.outcome === "fallback" || entry.outcome === "failed") &&
    typeof entry.inputTokensEstimate === "number" && Number.isSafeInteger(entry.inputTokensEstimate) && entry.inputTokensEstimate >= 0 &&
    typeof entry.outputTokensEstimate === "number" && Number.isSafeInteger(entry.outputTokensEstimate) && entry.outputTokensEstimate >= 0 &&
    (entry.error === undefined || typeof entry.error === "string") &&
    (entry.retries === undefined || (Number.isSafeInteger(entry.retries) && (entry.retries as number) >= 0));
}

function summarizeProviders(entries: readonly AgentTrace[]): ExecutionTraceDocument["providers"] {
  const providers = new Map<string, ExecutionTraceDocument["providers"][number]>();
  for (const entry of entries) {
    const current = providers.get(entry.provider) ?? { name: entry.provider, requests: 0, successes: 0, fallbacks: 0, failures: 0, retries: 0, durationMs: 0 };
    current.requests += 1;
    current.successes += entry.outcome === "success" ? 1 : 0;
    current.fallbacks += entry.outcome === "fallback" ? 1 : 0;
    current.failures += entry.outcome === "failed" ? 1 : 0;
    current.retries += entry.retries ?? 0;
    current.durationMs += entry.durationMs;
    providers.set(entry.provider, current);
  }
  return [...providers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function withTraceWriteLock<T>(directory: string, runId: string, action: () => Promise<T>): Promise<T> {
  const lock = path.join(directory, "." + runId + ".lock");
  const token = randomUUID();
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Execution trace is being updated by another or interrupted FORGE process. Inspect " + lock + " before manual recovery.");
    }
    throw error;
  }
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({
      token, pid: process.pid, startedAt: new Date().toISOString(),
    }) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    return await action();
  } finally {
    try {
      const owner: unknown = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
      if (owner && typeof owner === "object" && "token" in owner && owner.token === token) {
        await rm(lock, { recursive: true, force: true });
      }
    } catch {
      // Preserve an unverifiable lock for safe manual recovery.
    }
  }
}

export async function saveExecutionTrace(projectPath: string, runId: string, entries: readonly AgentTrace[]): Promise<string> {
  if (!/^forge-[a-z0-9-]{1,80}$/.test(runId) || runId.includes("..")) throw new Error("Invalid FORGE run identifier.");
  const directory = path.join(path.resolve(projectPath), ".forge", "traces");
  if (!Array.isArray(entries) || entries.some(entry => !isValidTraceEntry(entry))) {
    throw new Error("Execution trace contains an invalid agent entry.");
  }
  await mkdir(directory, { recursive: true });
  return withTraceWriteLock(directory, runId, async () => {
  const totals = {
    tasks: entries.length,
    successes: entries.filter(entry => entry.outcome === "success").length,
    fallbacks: entries.filter(entry => entry.outcome === "fallback").length,
    failures: entries.filter(entry => entry.outcome === "failed").length,
    estimatedInputTokens: entries.reduce((sum, entry) => sum + entry.inputTokensEstimate, 0),
    estimatedOutputTokens: entries.reduce((sum, entry) => sum + entry.outputTokensEstimate, 0),
    durationMs: entries.reduce((sum, entry) => sum + entry.durationMs, 0),
  };
  const document: ExecutionTraceDocument = { version: 1, runId, createdAt: new Date().toISOString(), entries: [...entries], totals, providers: summarizeProviders(entries) };
  const destination = path.join(directory, runId + ".json");
  let priorEntries: AgentTrace[] = [];
  let createdAt = document.createdAt;
  try {
    const previous = JSON.parse(await readFile(destination, "utf8")) as Partial<ExecutionTraceDocument>;
    if (previous.version !== 1 || previous.runId !== runId || !Array.isArray(previous.entries) ||
        previous.entries.some(entry => !isValidTraceEntry(entry))) throw new Error("Existing execution trace has an invalid format.");
    priorEntries = previous.entries;
    if (typeof previous.createdAt === "string") createdAt = previous.createdAt;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const combined = [...priorEntries, ...entries];
  const mergedTotals = {
    tasks: combined.length,
    successes: combined.filter(entry => entry.outcome === "success").length,
    fallbacks: combined.filter(entry => entry.outcome === "fallback").length,
    failures: combined.filter(entry => entry.outcome === "failed").length,
    estimatedInputTokens: combined.reduce((sum, entry) => sum + entry.inputTokensEstimate, 0),
    estimatedOutputTokens: combined.reduce((sum, entry) => sum + entry.outputTokensEstimate, 0),
    durationMs: combined.reduce((sum, entry) => sum + entry.durationMs, 0),
  };
  const mergedDocument: ExecutionTraceDocument = { version: 1, runId, createdAt, entries: combined, totals: mergedTotals, providers: summarizeProviders(combined) };
  const temporary = path.join(directory, "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(mergedDocument, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return destination;
  });
}

export async function loadExecutionTrace(projectPath: string, runId: string): Promise<ExecutionTraceDocument> {
  if (!/^forge-[a-z0-9-]{1,80}$/.test(runId) || runId.includes("..")) throw new Error("Invalid FORGE run identifier.");
  const file = path.join(path.resolve(projectPath), ".forge", "traces", runId + ".json");
  const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1 ||
      !("runId" in parsed) || parsed.runId !== runId || !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) ||
      !("entries" in parsed) || !Array.isArray(parsed.entries) ||
      parsed.entries.some(entry => !isValidTraceEntry(entry))) {
    throw new Error("Stored execution trace has an invalid format.");
  }
  return parsed as ExecutionTraceDocument;
}
