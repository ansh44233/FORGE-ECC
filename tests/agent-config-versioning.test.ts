import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadHooks } from "../src/core/hook-engine.js";
import { loadPermissionPolicy, validatePermissionPolicy } from "../src/core/permission-policy.js";
import {
  approveAgentConfigVersion, captureAgentConfigVersion, compareAgentConfigVersions,
  listAgentConfigVersions, loadAgentConfigVersion, materializeAgentConfigVersion
} from "../src/core/agent-config-versioning.js";

const roots: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "forge-agent-config-"));
  roots.push(root);
  await mkdir(path.join(root, ".forge", "agents"), { recursive: true });
  await mkdir(path.join(root, ".forge", "skills"), { recursive: true });
  await writeFile(path.join(root, ".forge", "agents", "planner.md"), "# Planner\nPlan carefully.\n");
  await writeFile(path.join(root, ".forge", "skills", "secure-changes.md"), "# Secure changes\nUse least privilege.\n");
  await writeFile(path.join(root, ".forge", "hooks.json"), JSON.stringify([{ id: "candidate-policy", event: "before-agent", action: "append-context", message: "Snapshot-specific policy guidance." }]));
  await writeFile(path.join(root, ".forge", "permissions.json"), JSON.stringify({ version: 1, mode: "proposal-only", allowedTools: [] }));
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("agent configuration versioning", () => {
  it("captures snapshots and compares changes without bypassing benchmark-gated approval", async () => {
    const root = await project();
    const first = await captureAgentConfigVersion(root, { createdBy: "developer", note: "baseline" });
    await writeFile(path.join(root, ".forge", "agents", "planner.md"), "# Planner\nPlan with acceptance criteria.\n");
    await writeFile(path.join(root, ".forge", "skills", "documentation.md"), "# Documentation\nKeep docs current.\n");
    await unlink(path.join(root, ".forge", "skills", "secure-changes.md"));
    const second = await captureAgentConfigVersion(root, { note: "candidate update" });
    const diff = compareAgentConfigVersions(first, second);
    expect(diff.changed).toEqual(["agents/planner.md"]);
    expect(diff.added).toEqual(["skills/documentation.md"]);
    expect(diff.removed).toEqual(["skills/secure-changes.md"]);
    await expect(approveAgentConfigVersion(root, second.id, "reviewer")).rejects.toThrow("Direct configuration approval is disabled");
    expect(await readFile(path.join(root, ".forge", "agents", "planner.md"), "utf8")).toContain("acceptance criteria");
    expect(await listAgentConfigVersions(root)).toHaveLength(2);
    expect((await loadAgentConfigVersion(root, second.id)).status).toBe("candidate");
    await expect(readFile(path.join(root, ".forge", "config-versions", "approved.json"), "utf8")).rejects.toThrow();
  });
  it("rejects traversal IDs and tampered snapshot contents", async () => {
    const root = await project();
    const version = await captureAgentConfigVersion(root);
    await expect(loadAgentConfigVersion(root, "../escape")).rejects.toThrow("Invalid configuration version ID");
    const file = path.join(root, ".forge", "config-versions", version.id + ".json");
    const parsed = JSON.parse(await readFile(file, "utf8"));
    parsed.files[0].content = "tampered";
    await writeFile(file, JSON.stringify(parsed));
    await expect(loadAgentConfigVersion(root, version.id)).rejects.toThrow("invalid file");
  });
  it("rejects symlinked agent configuration directories", async () => {
    const root = await project();
    const outside = path.join(root, "outside-agent-configs");
    await mkdir(outside);
    await writeFile(path.join(outside, "external.md"), "# External\\n");
    await rm(path.join(root, ".forge", "agents"), { recursive: true });
    await symlink(outside, path.join(root, ".forge", "agents"), "dir");
    await expect(captureAgentConfigVersion(root)).rejects.toThrow("must not be symbolic links");
  });
  it("materializes only verified snapshot files into a separate workspace", async () => {
    const root = await project();
    const version = await captureAgentConfigVersion(root);
    const isolated = path.join(root, "isolated-candidate");
    await mkdir(isolated);
    await materializeAgentConfigVersion(root, version.id, isolated);
    expect(await readFile(path.join(isolated, ".forge", "agents", "planner.md"), "utf8")).toContain("Plan carefully");
    expect(await readFile(path.join(isolated, ".forge", "skills", "secure-changes.md"), "utf8")).toContain("least privilege");
    await expect(readFile(path.join(root, ".forge", "agents", "planner.md"), "utf8")).resolves.toContain("Plan carefully");
    await expect(readFile(path.join(isolated, ".forge", "hooks.json"), "utf8")).resolves.toContain("Snapshot-specific policy guidance.");
    await expect(loadHooks(isolated)).resolves.toMatchObject([{ id: "candidate-policy", message: "Snapshot-specific policy guidance." }]);
    await expect(loadPermissionPolicy(isolated)).resolves.toEqual({ version: 1, mode: "proposal-only", allowedTools: [] });
  });
  it("captures an explicit empty hook policy when the workspace has no hooks file", async () => {
    const root = await project();
    await unlink(path.join(root, ".forge", "hooks.json"));
    const version = await captureAgentConfigVersion(root);
    const hooks = version.files.find(file => file.path === "hooks.json");
    expect(hooks?.content.trim()).toBe("[]");
    const isolated = path.join(root, "isolated-no-hooks");
    await mkdir(isolated);
    await materializeAgentConfigVersion(root, version.id, isolated);
    await expect(loadHooks(isolated)).resolves.toEqual([]);
  });
  it("rejects benchmark permission policies that enable tools or unknown fields", () => {
    expect(() => validatePermissionPolicy({ version: 1, mode: "restricted", allowedTools: ["shell"] })).not.toThrow();
    expect(() => validatePermissionPolicy({ version: 1, mode: "proposal-only", allowedTools: ["shell"] })).not.toThrow();
    expect(() => validatePermissionPolicy({ version: 1, mode: "proposal-only", allowedTools: [], execute: true })).toThrow("unsupported fields");
  });
  it("requires a workspace configuration to snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "forge-agent-config-empty-"));
    roots.push(root);
    await expect(captureAgentConfigVersion(root)).rejects.toThrow("No workspace agent or skill");
  });
});
