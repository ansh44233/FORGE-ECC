import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProject } from "../src/core/project-init.js";

describe("initializeProject", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  it("creates starter agents, skills, config, and memory", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-init-"));
    const result = await initializeProject(root);
    expect(result.created).toContain(".forge/forge.json");
    expect(result.created).toContain(".forge/agents/planner.md");
    expect(result.created).toContain(".forge/skills/verification-loop.md");
    expect(result.created).toContain(".forge/memory/README.md");
    const config = JSON.parse(await readFile(path.join(root, ".forge", "forge.json"), "utf8"));
    expect(config.defaults.approvalRequiredForFileWrites).toBe(true);
  });

  it("does not overwrite existing project instructions", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-init-"));
    const target = path.join(root, ".forge", "agents", "planner.md");
    await import("node:fs/promises").then(fs => fs.mkdir(path.dirname(target), { recursive: true }));
    await import("node:fs/promises").then(fs => fs.writeFile(target, "my custom planner", "utf8"));
    const result = await initializeProject(root);
    expect(result.skipped).toContain(".forge/agents/planner.md");
    expect(await readFile(target, "utf8")).toBe("my custom planner");
  });
});
