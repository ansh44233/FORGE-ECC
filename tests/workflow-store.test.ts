import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunFromWorkflow, listWorkflows, loadWorkflow, saveWorkflow } from "../src/core/workflow-store.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("reusable workflow store", () => {
  it("saves, lists, reloads and creates a draft run with dependency links", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workflows-"));
    const saved = await saveWorkflow(root, {
      id: "safe-release", name: "Safe release", description: "Review before shipping",
      tasks: [
        { id: "plan", agent: "planner", title: "Plan release", prompt: "Prepare a release plan." },
        { id: "security", agent: "security-reviewer", title: "Review security", prompt: "Review risks.", dependsOn: ["plan"], requiresApproval: true }
      ]
    });
    expect((await listWorkflows(root)).map(item => item.id)).toEqual(["safe-release"]);
    expect((await loadWorkflow(root, saved.id)).tasks[1]?.dependsOn).toEqual(["plan"]);
    const run = createRunFromWorkflow(saved);
    expect(run.status).toBe("pending");
    expect(run.tasks[1]?.task.requiresApproval).toBe(true);
  });

  it("rejects invalid dependency references and cyclic plans", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workflows-"));
    await expect(saveWorkflow(root, {
      id: "bad-flow", name: "Bad flow", description: "",
      tasks: [{ id: "one", agent: "planner", title: "One", prompt: "Do one", dependsOn: ["missing"] }]
    })).rejects.toThrow();
    await expect(saveWorkflow(root, {
      id: "cycle-flow", name: "Cycle flow", description: "",
      tasks: [
        { id: "one", agent: "planner", title: "One", prompt: "Do one", dependsOn: ["two"] },
        { id: "two", agent: "planner", title: "Two", prompt: "Do two", dependsOn: ["one"] }
      ]
    })).rejects.toThrow();
  });

  it("persists graph coordinates and rejects invalid node positions", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workflows-"));
    const saved = await saveWorkflow(root, {
      id: "position-flow", name: "Position flow", description: "",
      tasks: [{ id: "one", agent: "planner", title: "One", prompt: "Do one" }],
      positions: { one: { x: 320, y: 180 } }
    });
    expect((await loadWorkflow(root, saved.id)).positions?.one).toEqual({ x: 320, y: 180 });
    await expect(saveWorkflow(root, {
      id: "bad-position", name: "Bad position", description: "",
      tasks: [{ id: "one", agent: "planner", title: "One", prompt: "Do one" }],
      positions: { missing: { x: 10, y: 10 } }
    })).rejects.toThrow();
  });

  it("rejects excessive task counts and invalid identifiers", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-workflows-"));
    await expect(saveWorkflow(root, { id: "../escape", name: "Bad", description: "", tasks: [{ id: "x", agent: "planner", title: "X", prompt: "X" }] })).rejects.toThrow();
  });
});
