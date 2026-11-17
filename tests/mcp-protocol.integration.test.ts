import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

let workspace = "";
let child: ChildProcessWithoutNullStreams | undefined;

afterEach(async () => {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  child = undefined;
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("FORGE MCP stdio protocol integration", () => {
  it("lists tools, serves a read-only workspace call, and rejects traversal over JSON-RPC", async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-protocol-"));
    await mkdir(path.join(workspace, "src"));
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "mcp-fixture", scripts: {} }));
    await writeFile(path.join(workspace, "src", "index.ts"), "export const answer = 42;\n");
    await mkdir(path.join(workspace, ".forge"));
    await writeFile(path.join(workspace, ".forge", "permissions.json"), JSON.stringify({
      version: 1,
      mode: "restricted",
      allowedTools: ["list-files", "read-file", "search-code"]
    }));
    await writeFile(path.join(workspace, ".env"), "MCP_SENTINEL=must-not-be-listed\n");

    child = spawn(process.execPath, ["--import", "tsx", "src/mcp/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, FORGE_WORKSPACE: workspace },
      stdio: ["pipe", "pipe", "pipe"]
    });

    const pending = new Map<number, (message: any) => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id === "number") {
        const resolve = pending.get(message.id);
        if (resolve) {
          pending.delete(message.id);
          resolve(message);
        }
      }
    });

    let nextId = 1;
    const request = (method: string, params: unknown = {}) => {
      const id = nextId++;
      return new Promise<any>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP response to ${method}`));
        }, 10_000);
        pending.set(id, message => { clearTimeout(timeout); resolve(message); });
        child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    };
    const notify = (method: string, params: unknown = {}) => {
      child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    };

    const initialized = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "forge-mcp-integration-test", version: "1.0.0" }
    });
    expect(initialized.error).toBeUndefined();
    expect(initialized.result?.serverInfo?.name).toBe("forge-engineering-workbench");
    notify("notifications/initialized");

    const listed = await request("tools/list");
    expect(listed.error).toBeUndefined();
    const toolNames = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(toolNames).toContain("forge_list_files");
    expect(toolNames).toContain("forge_create_review_plan");

    const listing = await request("tools/call", {
      name: "forge_list_files",
      arguments: {}
    });
    expect(listing.error).toBeUndefined();
    expect(listing.result?.isError).not.toBe(true);
    const listingText = listing.result.content.find((part: { type: string }) => part.type === "text")?.text ?? "";
    expect(listingText).toContain('"name": "src"');
    expect(listingText).not.toContain(".env");
    expect(listingText).not.toContain("MCP_SENTINEL");

    const sourceListing = await request("tools/call", {
      name: "forge_list_files",
      arguments: { relativePath: "src" }
    });
    expect(sourceListing.result?.isError).not.toBe(true);
    const sourceListingText = sourceListing.result.content.find((part: { type: string }) => part.type === "text")?.text ?? "";
    expect(sourceListingText).toContain("src/index.ts");

    const read = await request("tools/call", {
      name: "forge_read_file",
      arguments: { relativePath: "src/index.ts" }
    });
    expect(read.result?.isError).not.toBe(true);
    const readText = read.result.content.find((part: { type: string }) => part.type === "text")?.text ?? "";
    expect(readText).toContain("export const answer = 42");

    const search = await request("tools/call", {
      name: "forge_search_code",
      arguments: { query: "answer" }
    });
    expect(search.result?.isError).not.toBe(true);
    const searchText = search.result.content.find((part: { type: string }) => part.type === "text")?.text ?? "";
    expect(searchText).toContain("src/index.ts");
    expect(searchText).toContain("answer");

    const denied = await request("tools/call", {
      name: "forge_list_files",
      arguments: { projectPath: "../outside" }
    });
    expect(denied.error).toBeUndefined();
    expect(denied.result?.isError).toBe(true);
    expect(denied.result.content[0].text).toMatch(/outside|workspace-relative/i);

    child!.stdin.end();
    lines.close();
  });
});
