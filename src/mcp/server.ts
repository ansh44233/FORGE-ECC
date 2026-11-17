#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { inspectProject } from "../core/project-inspector.js";
import { mapArchitecture } from "../core/architecture-map.js";
import { executeWorkspaceAgentTool } from "../core/workspace-tool-broker.js";
import { createWorkspaceResolver } from "./workspace-path.js";
import { loadPermissionPolicy } from "../core/permission-policy.js";
import { auditProject } from "../core/quality-audit.js";
import { analyzeGitChanges } from "../core/git-intelligence.js";
import { loadAgentRegistry } from "../core/agent-registry.js";
import { createReviewPlan } from "../core/review-planner.js";


const WORKSPACE_ROOT = await realpath(process.env.FORGE_WORKSPACE ?? process.cwd());

const resolveWorkspace = createWorkspaceResolver(WORKSPACE_ROOT);
function result(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "FORGE tool failed." }] };
}

async function auditReadOnlyMcpTool<T>(tool: string, operation: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await operation();
    process.stderr.write(JSON.stringify({
      type: "forge-tool-audit", tool, allowed: true, outcome: "success",
      at: new Date().toISOString(), durationMs: Date.now() - started,
      summary: "Read-only MCP operation completed."
    }) + String.fromCharCode(10));
    return value;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      type: "forge-tool-audit", tool, allowed: true, outcome: "error",
      at: new Date().toISOString(), durationMs: Date.now() - started,
      summary: "Read-only MCP operation failed."
    }) + String.fromCharCode(10));
    throw error;
  }
}

const server = new McpServer({
  name: "forge-engineering-workbench",
  version: "0.35.0"
});

server.registerTool(
  "forge_inspect_project",
  {
    title: "Inspect project",
    description: "Read-only inventory of a project: languages, frameworks, package managers, scripts, dependencies and detected warnings. Does not execute project code.",
    inputSchema: z.object({ projectPath: z.string().optional().describe("Workspace-relative directory. Defaults to the configured workspace root.") })
  },
  async ({ projectPath }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      return result(await auditReadOnlyMcpTool("forge_inspect_project", () => inspectProject(root)));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_map_architecture",
  {
    title: "Map architecture",
    description: "Read-only map of source files, internal imports, entry points and external packages. Does not execute project code.",
    inputSchema: z.object({ projectPath: z.string().optional().describe("Workspace-relative directory. Defaults to the configured workspace root.") })
  },
  async ({ projectPath }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      return result(await auditReadOnlyMcpTool("forge_map_architecture", () => mapArchitecture(root)));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_search_code",
  {
    title: "Search code",
    description: "Search source identifiers and text in a project. Secret-like filenames, hidden directories, dependencies and generated output are excluded by the underlying scanner.",
    inputSchema: z.object({
      query: z.string().min(2).max(120),
      projectPath: z.string().optional().describe("Workspace-relative directory. Defaults to the configured workspace root."),
      limit: z.number().int().min(1).max(100).optional()
    })
  },
  async ({ query, projectPath, limit }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      const policy = await loadPermissionPolicy(root);
      return result(await executeWorkspaceAgentTool(root, policy, "search-code", { query, limit: Math.min(limit ?? 10, 20) }, { onAudit: event => { process.stderr.write(JSON.stringify({ type: "forge-tool-audit", ...event }) + String.fromCharCode(10)); } }));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_list_files",
  {
    title: "List workspace files",
    description: "Read-only directory listing for supported source and documentation files. Hidden paths, secrets, dependencies, generated folders and symlinks are excluded. Results are bounded to 200 entries.",
    inputSchema: z.object({
      projectPath: z.string().optional().describe("Workspace-relative project directory. Defaults to the configured workspace root."),
      relativePath: z.string().max(500).optional().describe("Directory path relative to the selected project root.")
    })
  },
  async ({ projectPath, relativePath }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      const policy = await loadPermissionPolicy(root);
      return result(await executeWorkspaceAgentTool(root, policy, "list-files", { relativePath: relativePath ?? "" }, { onAudit: event => { process.stderr.write(JSON.stringify({ type: "forge-tool-audit", ...event }) + String.fromCharCode(10)); } }));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_read_file",
  {
    title: "Read workspace file",
    description: "Read a supported text/source file inside the selected project. Rejects traversal, symlinks, secret-like filenames, binary content and files larger than 128 KiB. Read-only; does not modify files.",
    inputSchema: z.object({
      projectPath: z.string().optional().describe("Workspace-relative project directory. Defaults to the configured workspace root."),
      relativePath: z.string().min(1).max(500).describe("File path relative to the selected project root.")
    })
  },
  async ({ projectPath, relativePath }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      const policy = await loadPermissionPolicy(root);
      return result(await executeWorkspaceAgentTool(root, policy, "read-file", { relativePath }, { onAudit: event => { process.stderr.write(JSON.stringify({ type: "forge-tool-audit", ...event }) + String.fromCharCode(10)); } }));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_quality_audit",
  {
    title: "Audit project quality",
    description: "Run FORGE's static, heuristic project-quality checks and return evidence-backed findings. Does not inspect secret contents, execute project code, or query vulnerability databases.",
    inputSchema: z.object({ projectPath: z.string().optional() })
  },
  async ({ projectPath }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      return result(await auditReadOnlyMcpTool("forge_quality_audit", () => auditProject(root)));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_git_intelligence",
  {
    title: "Analyze Git changes",
    description: "Read-only analysis of working-tree changes, static downstream impact, suggested test targets and heuristic change risk. Runs Git inspection commands only; it does not modify the repository or execute project scripts.",
    inputSchema: z.object({
      projectPath: z.string().optional(),
      base: z.string().min(1).max(120).optional()
    })
  },
  async ({ projectPath, base }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      return result(await auditReadOnlyMcpTool("forge_git_intelligence", () => analyzeGitChanges(root, base ?? "HEAD")));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_list_agents",
  {
    title: "List specialist agents",
    description: "List built-in FORGE specialist roles and project-local .forge/agents definitions. Agent markdown is treated as untrusted project content.",
    inputSchema: z.object({ projectPath: z.string().optional() })
  },
  async ({ projectPath }) => {
    try {
      const root = await resolveWorkspace(projectPath);
      const agents = await auditReadOnlyMcpTool("forge_list_agents", () => loadAgentRegistry(root));
      return result(agents.map(({ id, name, description, source }) => ({ id, name, description, source })));
    } catch (error) { return failure(error); }
  }
);

server.registerTool(
  "forge_create_review_plan",
  {
    title: "Create engineering review plan",
    description: "Create a dependency-aware engineering workflow with architecture, planning, code review, security, performance, debugging, testing, documentation, delivery and release-readiness specialist tasks. This creates a draft only; it does not call an AI provider, modify files, or execute commands.",
    inputSchema: z.object({ goal: z.string().min(5).max(2000) })
  },
  async ({ goal }) => {
    try {
      return result(createReviewPlan(goal));
    } catch (error) { return failure(error); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
