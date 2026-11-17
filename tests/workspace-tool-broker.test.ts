import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executeWorkspaceAgentTool, WORKSPACE_AGENT_TOOLS, type WorkspaceToolAuditEvent } from "../src/core/workspace-tool-broker.js";
import { DEFAULT_PERMISSION_POLICY, validatePermissionPolicy } from "../src/core/permission-policy.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("workspace tool broker", () => {
  it("exposes only bounded read-only tools", () => {
    expect(WORKSPACE_AGENT_TOOLS.map(tool => tool.name)).toEqual(["list-files", "read-file", "search-code"]);
  });

  it("denies calls unless explicitly allowlisted and records the denial", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-tool-broker-"));
    const audit: WorkspaceToolAuditEvent[] = [];
    await expect(executeWorkspaceAgentTool(root, DEFAULT_PERMISSION_POLICY, "list-files", {}, { onAudit: event => { audit.push(event); } })).rejects.toThrow(/denied by permission policy/);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("denied");
  });

  it("executes allowlisted reads and records metadata without file contents", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-tool-broker-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "auth.ts"), "export function authenticateUser() { return true; }");
    const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file", "search-code", "list-files"] });
    const audit: WorkspaceToolAuditEvent[] = [];
    const files = await executeWorkspaceAgentTool(root, policy, "list-files", {}, { onAudit: event => { audit.push(event); } }) as { entries: Array<{ name: string }> };
    expect(files.entries.map(entry => entry.name)).toContain("src");
    const file = await executeWorkspaceAgentTool(root, policy, "read-file", { relativePath: "src/auth.ts" }) as { content: string };
    expect(file.content).toContain("authenticateUser");
    const search = await executeWorkspaceAgentTool(root, policy, "search-code", { query: "authenticateUser", limit: 5 }) as { results: unknown[] };
    expect(search.results.length).toBeGreaterThan(0);
    expect(audit.every(event => event.outcome === "success")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("authenticateUser");
  });

  it("rejects unknown tools, invalid arguments and traversal", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-tool-broker-"));
    const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file"] });
    await expect(executeWorkspaceAgentTool(root, policy, "shell", {})).rejects.toThrow(/Unknown workspace tool/);
    await expect(executeWorkspaceAgentTool(root, policy, "read-file", { relativePath: "../outside.ts" })).rejects.toThrow();
  });

  it("does not put project paths or filesystem error details in audit summaries", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-audit-private-"));
    const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file"] });
    const audit: WorkspaceToolAuditEvent[] = [];
    await expect(executeWorkspaceAgentTool(root, policy, "read-file", { relativePath: "missing-private-project-file.ts" }, { onAudit: event => { audit.push(event); } })).rejects.toThrow();
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("error");
    expect(audit[0]?.summary).toBe("Workspace tool operation failed.");
    expect(JSON.stringify(audit)).not.toContain("missing-private-project-file");
    expect(JSON.stringify(audit)).not.toContain(root);
  });

  it("does not include filenames in successful read audit summaries", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-audit-filename-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "component-name.ts"), "export const value = 1;");
    const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file"] });
    const audit: WorkspaceToolAuditEvent[] = [];
    await executeWorkspaceAgentTool(root, policy, "read-file", { relativePath: "src/component-name.ts" }, { onAudit: event => { audit.push(event); } });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.summary).toMatch(/^Read one file \(\d+ bytes\)\.$/);
    expect(JSON.stringify(audit)).not.toContain("private-component-name");
    expect(JSON.stringify(audit)).not.toContain(root);
  });

  it("blocks direct reads through sensitive directory names", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-tool-broker-"));
    await mkdir(path.join(root, "credentials"), { recursive: true });
    await writeFile(path.join(root, "credentials", "notes.txt"), "must-not-be-read");
    const policy = validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["read-file", "list-files"] });
    await expect(executeWorkspaceAgentTool(root, policy, "read-file", { relativePath: "credentials/notes.txt" })).rejects.toThrow(/Sensitive workspace paths/);
    await expect(executeWorkspaceAgentTool(root, policy, "list-files", { relativePath: "credentials" })).rejects.toThrow(/Sensitive workspace paths/);
  });

});
