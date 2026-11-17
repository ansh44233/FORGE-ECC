import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRun } from "../src/core/orchestrator.js";
import { saveRun } from "../src/core/run-store.js";

function runCli(...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

const temporaryDirectories: string[] = [];
async function createWorkspace(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forge-cli-help-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("run-history CLI help", () => {
  it("prints runs usage without reading project history", () => {
    expect(runCli("runs", "--help")).toContain("Usage: forge runs [path] [--json] [--limit N] [--status STATUS]");
  });

  it("documents the versioned JSON option and run limit", () => {
    const help = runCli("runs", "--help");
    expect(help).toContain("versioned machine-readable summary");
    expect(help).toContain("--limit N");
    expect(help).toContain("--status");
  });

  it("prints show-run usage without requiring a run ID", () => {
    expect(runCli("show-run", "--help")).toContain("Usage: forge show-run RUN_ID [--path PROJECT]");
  });

  it("rejects malformed show-run arguments", async () => {
    const directory = await createWorkspace();
    for (const args of [
      ["forge-example", "--path"],
      ["forge-example", "--path", "--json"],
      ["forge-example", "--path", directory, "--path", directory],
      ["forge-example", "extra"],
      ["forge-example", "--unexpected"],
    ]) {
      expect(() => runCli("show-run", ...args)).toThrow();
    }
  }, 20_000);

  it("limits text and JSON history to the newest runs", async () => {
    const directory = await createWorkspace();
    const older = createRun("Older run", [{ id: "older-task", agent: "planner", title: "Older task", prompt: "Plan older run" }]);
    older.createdAt = "2026-01-01T00:00:00.000Z";
    older.status = "failed";
    const newer = createRun("Newer run", [{ id: "newer-task", agent: "planner", title: "Newer task", prompt: "Plan newer run" }]);
    newer.createdAt = "2026-01-02T00:00:00.000Z";
    newer.status = "completed";
    const newest = createRun("Newest run", [{ id: "newest-task", agent: "planner", title: "Newest task", prompt: "Plan newest run" }]);
    newest.createdAt = "2026-01-03T00:00:00.000Z";
    newest.status = "completed";
    await saveRun(directory, older);
    await saveRun(directory, newer);
    await saveRun(directory, newest);

    const textOutput = runCli("runs", directory, "--limit", "1");
    expect(textOutput).toContain(newest.id);
    expect(textOutput).not.toContain(newer.id);
    expect(textOutput).not.toContain(older.id);

    const jsonOutput = JSON.parse(runCli("runs", directory, "--json", "--limit", "1"));
    expect(jsonOutput.runs).toHaveLength(1);
    expect(jsonOutput.runs[0].id).toBe(newest.id);

    const completedOutput = runCli("runs", directory, "--status", "completed");
    expect(completedOutput).toContain(newer.id);
    expect(completedOutput).toContain(newest.id);
    expect(completedOutput).not.toContain(older.id);
    const combinedJson = JSON.parse(runCli("runs", "--status", "completed", "--limit", "1", directory, "--json"));
    expect(combinedJson.runs).toHaveLength(1);
    expect(combinedJson.runs[0].id).toBe(newest.id);
    const failedJson = JSON.parse(runCli("runs", directory, "--json", "--status", "failed"));
    expect(failedJson.runs.map((run: { id: string }) => run.id)).toEqual([older.id]);
  }, 20_000);

  it("rejects missing and invalid run-history option values", async () => {
    const directory = await createWorkspace();
    for (const args of [
      ["--limit"], ["--limit", "0"], ["--limit", "many"], ["--limit", "--json"],
      ["--status"], ["--status", "unknown"], ["--status", "--json"],
    ]) {
      expect(() => runCli("runs", directory, ...args)).toThrow();
    }
  }, 20_000);

  it("rejects duplicate and unknown run-history options", async () => {
    const directory = await createWorkspace();
    for (const args of [
      ["--limit", "1", "--limit", "2"], ["--status", "completed", "--status", "failed"],
      ["--json", "--json"], ["--unexpected"],
      ["first-project", "second-project"],
      ["--limit", "1", "first-project", "second-project"],
    ]) {
      expect(() => runCli("runs", directory, ...args)).toThrow();
    }
  }, 20_000);
});
