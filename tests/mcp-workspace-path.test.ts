import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceResolver } from "../src/mcp/workspace-path.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("MCP workspace path resolver", () => {
  it("allows the workspace root and safe nested project directories", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-path-"));
    await mkdir(path.join(root, "apps", "web"), { recursive: true });
    const resolve = createWorkspaceResolver(root);
    expect(await resolve()).toBe(root);
    expect(await resolve("apps/web")).toBe(path.join(root, "apps", "web"));
  });

  it("rejects traversal, absolute paths, hidden roots and oversized input", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-path-"));
    const resolve = createWorkspaceResolver(root);
    await expect(resolve("../outside")).rejects.toThrow(/outside/);
    await expect(resolve(".forge")).rejects.toThrow(/Hidden or excluded/);
    await expect(resolve("src\\..\\outside")).rejects.toThrow(/outside/);
    await expect(resolve("x".repeat(501))).rejects.toThrow(/workspace-relative/);
    await expect(resolve(path.resolve(root, "elsewhere"))).rejects.toThrow(/workspace-relative/);
  });

  it("rejects symlinked path components even when they resolve inside the workspace", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-path-"));
    await mkdir(path.join(root, "real-project"));
    await symlink(path.join(root, "real-project"), path.join(root, "linked-project"), "dir");
    const resolve = createWorkspaceResolver(root);
    await expect(resolve("linked-project")).rejects.toThrow(/Symbolic links/);
  });

  it("rejects symlinks that escape the configured workspace", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-path-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "forge-mcp-outside-"));
    try {
      await symlink(outside, path.join(root, "external"), "dir");
      await expect(createWorkspaceResolver(root)("external")).rejects.toThrow(/Symbolic links/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
