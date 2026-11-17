import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareVerification, formatVerificationComparison, listVerifications, saveVerification } from "../src/core/verification-history.js";
import type { VerificationResult } from "../src/core/verification.js";

const result = (id: string, status: VerificationResult["status"], startedAt: string): VerificationResult => ({
  id, projectPath: "/demo", script: "test", command: "npm run-script --ignore-scripts test", status, exitCode: status === "passed" ? 0 : 1, signal: null, durationMs: 42, startedAt, finishedAt: startedAt, output: "", outputTruncated: false
});

describe("verification history", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
  it("persists results locally and lists newest first", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-history-"));
    await saveVerification(root, result("verify-older0001", "passed", "2026-01-01T00:00:00.000Z"));
    await saveVerification(root, result("verify-newer0002", "failed", "2026-01-02T00:00:00.000Z"));
    const history = await listVerifications(root);
    expect(history.map(item => item.id)).toEqual(["verify-newer0002", "verify-older0001"]);
  });
  it("detects regressions and improvements against the previous same-script run", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-history-"));
    await saveVerification(root, result("verify-older0001", "passed", "2026-01-01T00:00:00.000Z"));
    const failed = result("verify-newer0002", "failed", "2026-01-02T00:00:00.000Z");
    await saveVerification(root, failed);
    const regression = await compareVerification(root, failed);
    expect(regression.change).toBe("regression");
    expect(formatVerificationComparison(regression)).toContain("REGRESSION");
    const passed = result("verify-latest0003", "passed", "2026-01-03T00:00:00.000Z");
    const improvement = await compareVerification(root, passed);
    expect(improvement.change).toBe("improvement");
  });
  it("returns an empty history when no records exist", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-history-"));
    expect(await listVerifications(root)).toEqual([]);
  });
});