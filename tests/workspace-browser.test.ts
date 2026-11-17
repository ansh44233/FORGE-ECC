import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertWorkspacePathAllowed, listWorkspaceDirectory, readWorkspaceFile } from "../src/core/workspace-browser.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("workspace browser", () => {
  it("lists safe directories and previews supported source files", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workspace-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "index.ts"), "export const answer = 42;\n");
    await writeFile(path.join(root, ".env"), "TOKEN=do-not-show");
    await mkdir(path.join(root, "node_modules"));
    const listing = await listWorkspaceDirectory(root);
    expect(listing.entries.map(item => item.name)).toContain("src");
    expect(listing.entries.map(item => item.name)).not.toContain(".env");
    expect(listing.entries.map(item => item.name)).not.toContain("node_modules");
    const preview = await readWorkspaceFile(root, "src/index.ts");
    expect(preview.content).toContain("answer = 42");
  });

  it("rejects traversal and sensitive files", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workspace-"));
    await writeFile(path.join(root, ".env"), "SECRET=value");
    await expect(listWorkspaceDirectory(root, "../")).rejects.toThrow("inside the project");
    await expect(readWorkspaceFile(root, ".env")).rejects.toThrow();
  });

  it("rejects symlinks and oversized previews", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workspace-"));
    const outside = path.join(root, "outside.ts");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(root, "linked.ts"));
    const outsideDir = path.join(root, "outside-dir");
    await mkdir(outsideDir);
    await writeFile(path.join(outsideDir, "hidden.ts"), "do not follow directory symlink");
    await symlink(outsideDir, path.join(root, "linked-dir"));
    await writeFile(path.join(root, "large.ts"), "x".repeat(129 * 1024));
    const listing = await listWorkspaceDirectory(root);
    expect(listing.entries.map(item => item.name)).not.toContain("linked.ts");
    expect(listing.entries.map(item => item.name)).not.toContain("linked-dir");
    await expect(readWorkspaceFile(root, "linked.ts")).rejects.toThrow();
    await expect(listWorkspaceDirectory(root, "linked-dir")).rejects.toThrow();
    await expect(readWorkspaceFile(root, "large.ts")).rejects.toThrow("128 KiB");
  });

  it("applies the same visibility rules to selected project roots", () => {
    for (const relativePath of [".forge", ".git", "node_modules", "dist", ".turbo"]) {
      expect(() => assertWorkspacePathAllowed(relativePath)).toThrow(/Hidden or excluded/);
    }
    expect(() => assertWorkspacePathAllowed("src")).not.toThrow();
    expect(() => assertWorkspacePathAllowed("credentials")).toThrow(/Sensitive workspace paths/);
  });

  it("rejects direct browsing of hidden and excluded directories", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workspace-"));
    for (const directory of [".forge", ".git", "node_modules", "dist", ".turbo"]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "notes.ts"), "private workspace data");
      await expect(listWorkspaceDirectory(root, directory)).rejects.toThrow(/Hidden or excluded/);
      await expect(readWorkspaceFile(root, directory + "/notes.ts")).rejects.toThrow(/Hidden or excluded/);
    }
  });

  it("blocks sensitive path segments even when the leaf filename looks harmless", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workspace-"));
    await mkdir(path.join(root, "credentials"));
    await writeFile(path.join(root, "credentials", "notes.txt"), "private material");
    await expect(listWorkspaceDirectory(root, "credentials")).rejects.toThrow(/Sensitive workspace paths/);
    await expect(readWorkspaceFile(root, "credentials/notes.txt")).rejects.toThrow(/Sensitive workspace paths/);
  });

});
