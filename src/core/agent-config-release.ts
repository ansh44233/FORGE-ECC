import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadAgentConfigVersion, type AgentConfigVersion } from "./agent-config-versioning.js";
import type { BenchmarkRegressionReport } from "./benchmark-regression.js";
import { fingerprintAgentConfig } from "./benchmark-matrix.js";

export interface AgentConfigRelease {
  version: 1;
  id: string;
  createdAt: string;
  candidateVersionId: string;
  baselineVersionId: string;
  benchmarkMatrixId: string;
  benchmarkStatus: BenchmarkRegressionReport["status"];
  status: "pending-approval" | "approved" | "rejected";
  reviewer?: string;
  decisionAt?: string;
  summary: string[];
}
const ID = /^rel-[a-f0-9]{12}$/;
function directory(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".forge", "config-releases");
}
async function atomicWrite(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
function validate(value: unknown): AgentConfigRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent configuration release record.");
  const item = value as AgentConfigRelease;
  if (item.version !== 1 || !ID.test(item.id) || typeof item.createdAt !== "string" ||
      !/^cfg-[a-f0-9]{12}$/.test(item.candidateVersionId) || !/^cfg-[a-f0-9]{12}$/.test(item.baselineVersionId) ||
      typeof item.benchmarkMatrixId !== "string" ||
      !["release-ready", "warning", "blocked", "insufficient-history"].includes(item.benchmarkStatus) ||
      !["pending-approval", "approved", "rejected"].includes(item.status) || !Array.isArray(item.summary) ||
      item.summary.some(line => typeof line !== "string")) throw new Error("Malformed agent configuration release record.");
  return item;
}
export async function prepareAgentConfigRelease(projectPath: string, input: {
  candidateVersionId: string; baselineVersionId: string; regression: BenchmarkRegressionReport;
}): Promise<AgentConfigRelease> {
  const [candidate, baseline] = await Promise.all([
    loadAgentConfigVersion(projectPath, input.candidateVersionId),
    loadAgentConfigVersion(projectPath, input.baselineVersionId)
  ]);
  if (candidate.status !== "candidate") throw new Error("Release candidate must be an unapproved configuration snapshot.");
  if (baseline.status !== "approved") throw new Error("Release baseline must be an approved configuration snapshot.");
  if (candidate.id === baseline.id) throw new Error("Candidate and baseline must be different snapshots.");
  if (input.regression.status !== "release-ready") throw new Error("Promotion blocked: benchmark regression status is " + input.regression.status + ". Resolve warnings/regressions and obtain a release-ready comparable benchmark first.");
  const provenance = input.regression.candidateProvenance?.find(item => item.configVersionId === candidate.id);
  if (!provenance || provenance.fingerprint !== fingerprintAgentConfig(candidate.files)) throw new Error("Promotion blocked: the release candidate does not match a configuration snapshot fingerprint recorded in the benchmark matrix. Re-run the matrix with candidate.configVersionId set to this snapshot.");
  const release: AgentConfigRelease = {
    version: 1, id: "rel-" + randomUUID().replace(/-/g, "").slice(0,12),
    createdAt: new Date().toISOString(), candidateVersionId: candidate.id, baselineVersionId: baseline.id,
    benchmarkMatrixId: input.regression.matrixId, benchmarkStatus: input.regression.status,
    status: "pending-approval", summary: [...input.regression.summary]
  };
  await atomicWrite(path.join(directory(projectPath), release.id + ".json"), JSON.stringify(release, null, 2) + "\n");
  return release;
}
export async function listAgentConfigReleases(projectPath: string): Promise<AgentConfigRelease[]> {
  let entries;
  try { entries = await readdir(directory(projectPath), { withFileTypes: true }); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []; throw error; }
  const items: AgentConfigRelease[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || !ID.test(entry.name.slice(0,-5))) continue;
    items.push(validate(JSON.parse(await readFile(path.join(directory(projectPath), entry.name), "utf8"))));
  }
  return items.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export async function decideAgentConfigRelease(projectPath: string, id: string, reviewer: string, decision: "approve" | "reject"): Promise<AgentConfigRelease> {
  if (!ID.test(id)) throw new Error("Invalid release ID.");
  if (!reviewer.trim() || reviewer.length > 80) throw new Error("A reviewer name of 1–80 characters is required.");
  const file = path.join(directory(projectPath), id + ".json");
  const current = validate(JSON.parse(await readFile(file, "utf8")));
  if (current.status !== "pending-approval") throw new Error("Only pending releases can be approved or rejected.");
  const updated: AgentConfigRelease = { ...current, status: decision === "approve" ? "approved" : "rejected", reviewer: reviewer.trim(), decisionAt: new Date().toISOString() };
  await atomicWrite(file, JSON.stringify(updated, null, 2) + "\n");
  if (decision === "approve") {
    const version: AgentConfigVersion = await loadAgentConfigVersion(projectPath, current.candidateVersionId);
    const approved = { ...version, status: "approved" as const, approvedBy: reviewer.trim() };
    await atomicWrite(path.join(path.resolve(projectPath), ".forge", "config-versions", version.id + ".json"), JSON.stringify(approved, null, 2) + "\n");
    await atomicWrite(path.join(path.resolve(projectPath), ".forge", "config-versions", "approved.json"), JSON.stringify({ version: 1, activeApprovedVersionId: version.id, updatedAt: new Date().toISOString(), releaseId: id }, null, 2) + "\n");
  }
  return updated;
}
export function formatAgentConfigRelease(item: AgentConfigRelease): string {
  return [
    "FORGE Agent Configuration Release " + item.id,
    "Status: " + item.status.toUpperCase(),
    "Candidate: " + item.candidateVersionId,
    "Approved baseline: " + item.baselineVersionId,
    "Benchmark matrix: " + item.benchmarkMatrixId,
    "Benchmark gate: " + item.benchmarkStatus,
    ...(item.reviewer ? ["Reviewer: " + item.reviewer, "Decision: " + item.decisionAt] : []),
    ...item.summary.map(line => "  " + line)
  ].join("\n");
}
