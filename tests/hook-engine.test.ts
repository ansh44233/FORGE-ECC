import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBeforeAgentHooks, loadHooks } from "../src/core/hook-engine.js";

describe("declarative lifecycle hooks", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
  it("loads policy hooks and applies matching approval, context and block actions", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-hooks-"));
    const dir = path.join(root, ".forge");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "hooks.json"), JSON.stringify([
      { id: "secure-approval", event: "before-agent", action: "require-approval", match: { contains: ["authentication"] }, message: "Review before proceeding." },
      { id: "security-context", event: "before-agent", action: "append-context", match: { agents: ["security-reviewer"] }, message: "Use least privilege." },
      { id: "block-dangerous", event: "before-agent", action: "block-task", match: { contains: ["production wipe"] }, message: "Destructive production actions are blocked." }
    ]));
    const hooks = await loadHooks(root);
    const approval = applyBeforeAgentHooks({ id: "auth", agent: "planner", title: "Authentication plan", prompt: "Design login" }, hooks);
    expect(approval.approvalRequired).toBe(true);
    const context = applyBeforeAgentHooks({ id: "sec", agent: "security-reviewer", title: "Security", prompt: "Review" }, hooks);
    expect(context.context).toContain("Use least privilege.");
    const blocked = applyBeforeAgentHooks({ id: "wipe", agent: "devops-engineer", title: "Production wipe", prompt: "production wipe" }, hooks);
    expect(blocked.blockedReason).toContain("blocked");
  });
  it("rejects duplicate IDs and malformed filters", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-hooks-"));
    const dir = path.join(root, ".forge");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "hooks.json"), JSON.stringify([
      { id: "same", event: "before-agent", action: "append-context", message: "one" },
      { id: "same", event: "before-agent", action: "append-context", message: "two" }
    ]));
    await expect(loadHooks(root)).rejects.toThrow("duplicated");
    await writeFile(path.join(dir, "hooks.json"), JSON.stringify([
      { id: "bad-filter", event: "before-agent", action: "append-context", message: "x", match: { agents: [""] } }
    ]));
    await expect(loadHooks(root)).rejects.toThrow("invalid agent filters");
  });
  it("rejects unsupported hook actions", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-hooks-"));
    const dir = path.join(root, ".forge");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "hooks.json"), JSON.stringify([{ id: "bad", event: "before-agent", action: "run-shell", message: "no" }]));
    await expect(loadHooks(root)).rejects.toThrow("unsupported action");
  });
});
