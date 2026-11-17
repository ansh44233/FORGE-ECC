import { listWorkspaceDirectory, readWorkspaceFile } from "./workspace-browser.js";
import { searchWorkspace } from "./code-search.js";
import type { ForgePermissionPolicy } from "./permission-policy.js";

export const WORKSPACE_AGENT_TOOLS = [
  { name: "list-files", description: "List safe project files and directories under the workspace." },
  { name: "read-file", description: "Read a supported text/source file inside the workspace." },
  { name: "search-code", description: "Search TypeScript and JavaScript source for a symbol or text query." },
] as const;

export type WorkspaceAgentToolName = typeof WORKSPACE_AGENT_TOOLS[number]["name"];
export interface WorkspaceToolAuditEvent {
  tool: WorkspaceAgentToolName;
  allowed: boolean;
  outcome: "success" | "denied" | "error";
  at: string;
  durationMs: number;
  summary: string;
}
export interface WorkspaceToolBrokerOptions {
  onAudit?: (event: WorkspaceToolAuditEvent) => void | Promise<void>;
}

function record(
  options: WorkspaceToolBrokerOptions,
  event: WorkspaceToolAuditEvent,
): Promise<void> {
  return Promise.resolve(options.onAudit?.(event)).then(() => undefined);
}
function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool input must be an object.");
  return value as Record<string, unknown>;
}
function optionalPath(input: Record<string, unknown>): string {
  const value = input.relativePath ?? "";
  if (typeof value !== "string" || value.length > 500) throw new Error("relativePath must be a string up to 500 characters.");
  return value;
}

/**
 * Executes only explicitly allowlisted, read-only workspace tools.
 * It has no shell, network, process, write, patch or arbitrary filesystem capability.
 */
export async function executeWorkspaceAgentTool(
  projectPath: string,
  policy: ForgePermissionPolicy,
  toolName: string,
  rawInput: unknown,
  options: WorkspaceToolBrokerOptions = {},
): Promise<unknown> {
  const tool = WORKSPACE_AGENT_TOOLS.find(item => item.name === toolName);
  if (!tool) throw new Error("Unknown workspace tool: " + toolName);
  const started = Date.now();
  if (policy.mode !== "restricted" || !policy.allowedTools.includes(tool.name)) {
    await record(options, { tool: tool.name, allowed: false, outcome: "denied", at: new Date().toISOString(), durationMs: Date.now() - started, summary: "Tool is not enabled by the active permission policy." });
    throw new Error("Workspace tool denied by permission policy: " + tool.name);
  }
  try {
    const input = objectInput(rawInput);
    let result: unknown;
    let summary: string;
    if (tool.name === "list-files") {
      const listing = await listWorkspaceDirectory(projectPath, optionalPath(input));
      result = listing;
      summary = "Listed " + listing.entries.length + " entries.";
    } else if (tool.name === "read-file") {
      const relativePath = input.relativePath;
      if (typeof relativePath !== "string" || !relativePath.length || relativePath.length > 500) throw new Error("read-file requires a relativePath string up to 500 characters.");
      result = await readWorkspaceFile(projectPath, relativePath);
      summary = "Read one file (" + (result as { size: number }).size + " bytes).";
    } else {
      const query = input.query;
      if (typeof query !== "string" || query.trim().length < 2 || query.length > 120) throw new Error("search-code requires a query between 2 and 120 characters.");
      const limit = input.limit === undefined ? 10 : input.limit;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("search-code limit must be an integer from 1 to 20.");
      result = await searchWorkspace(projectPath, query, limit);
      const report = result as { results: unknown[]; filesScanned: number };
      summary = "Found " + report.results.length + " matches across " + report.filesScanned + " scanned files.";
    }
    await record(options, { tool: tool.name, allowed: true, outcome: "success", at: new Date().toISOString(), durationMs: Date.now() - started, summary });
    return result;
  } catch (error) {
    await record(options, { tool: tool.name, allowed: true, outcome: "error", at: new Date().toISOString(), durationMs: Date.now() - started, summary: "Workspace tool operation failed." });
    throw error;
  }
}
