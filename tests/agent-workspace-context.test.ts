import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildAgentWorkspaceContext } from "../src/core/agent-workspace-context.js";

let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });

describe("agent workspace context", () => {
  it("provides bounded read-only source evidence relevant to a task", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-agent-context-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "auth.ts"), "export function authenticateUser(token: string) { return token.length > 0; }\n");
    await writeFile(path.join(root, ".env"), "AUTHENTICATE_USER_SECRET=never-expose-this");
    const context = await buildAgentWorkspaceContext(root, {
      agent: "security-reviewer", title: "Review authenticateUser", prompt: "Inspect token validation behavior",
    });
    expect(context).toContain("READ-ONLY WORKSPACE TOOL RESULTS");
    expect(context).toContain("src/auth.ts");
    expect(context).toContain("authenticateUser");
    expect(context).not.toContain("never-expose-this");
    expect(context).toContain("No files were changed");
  });

  it("caps context size and handles tasks with no useful terms", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-agent-context-"));
    const empty = await buildAgentWorkspaceContext(root, { agent: "review", title: "Review", prompt: "Build project" });
    expect(empty).toContain("no safe search terms");
    await writeFile(path.join(root, "long.ts"), Array.from({ length: 80 }, (_, i) => `export const authenticateValue${i} = ${i};`).join("\n"));
    const bounded = await buildAgentWorkspaceContext(root, { agent: "reviewer", title: "authenticateValue", prompt: "Review authentication implementation" }, { maxCharacters: 700 });
    expect(bounded.length).toBeLessThanOrEqual(700);
  });
});
