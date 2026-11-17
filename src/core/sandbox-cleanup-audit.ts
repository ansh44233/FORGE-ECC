import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface SandboxCleanupAuditEntry {
  id: string;
  timestamp: string;
  mode: "dry-run" | "apply";
  candidates: Array<{ id: string; name: string; status: string }>;
  removed: string[];
}

const MAX_ENTRIES = 200;
const FILE_NAME = "sandbox-cleanup-history.json";

export async function appendSandboxCleanupAudit(
  projectRoot: string,
  entry: SandboxCleanupAuditEntry,
): Promise<void> {
  const directory = path.join(projectRoot, ".forge");
  const file = path.join(directory, FILE_NAME);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let entries: SandboxCleanupAuditEntry[] = [];
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid sandbox cleanup audit history.");
    entries = parsed as SandboxCleanupAuditEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  entries.push(entry);
  await writeFile(file, JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function readSandboxCleanupAudit(projectRoot: string): Promise<SandboxCleanupAuditEntry[]> {
  const file = path.join(projectRoot, ".forge", FILE_NAME);
  try {
    const raw = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid sandbox cleanup audit history.");
    return (parsed as SandboxCleanupAuditEntry[]).slice(-MAX_ENTRIES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function formatSandboxCleanupHistory(entries: SandboxCleanupAuditEntry[]): string {
  if (!entries.length) return "# FORGE Sandbox Cleanup History\n\nNo cleanup runs recorded yet.";
  return [
    "# FORGE Sandbox Cleanup History",
    "",
    ...entries.map(entry => [
      "## " + entry.timestamp + " — " + entry.mode.toUpperCase(),
      "- Run: " + entry.id,
      "- Candidates: " + entry.candidates.length,
      "- Removed: " + entry.removed.length,
      ...(entry.removed.length ? ["- Removed IDs: " + entry.removed.join(", ")] : []),
    ].join("\n")),
  ].join("\n\n");
}
