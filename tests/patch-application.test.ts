import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveReview } from "../src/core/review-history.js";
import { approveReviewPatch } from "../src/core/patch-approval.js";
import { stageApprovedPatch, reviewStagedPatch, promoteStagedPatch, rollbackStagedPatch } from "../src/core/patch-application.js";
import { verifyStagedPatch } from "../src/core/staged-verification.js";
import type { CodeReviewReport } from "../src/core/code-review.js";
import type { AIReviewResult } from "../src/core/ai-code-review.js";

describe("isolated approved patch staging", () => {
  let root = "";
  const afterEachCleanup: string[] = [];
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    for (const item of afterEachCleanup.splice(0)) await rm(item, { recursive: true, force: true });
  });
  async function fixture() {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-patch-stage-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/a.ts"), "const a = 1;\n");
    const report = {
      root, generatedAt: new Date().toISOString(), scope: "source-files" as const, base: "HEAD",
      filesReviewed: ["src/a.ts"], findings: [], summary: { high: 0, medium: 0, low: 0 }, warnings: [],
    } as CodeReviewReport;
    const ai = {
      provider: "mock",
      suggestions: [{
        file: "src/a.ts", line: 1, severity: "low" as const, title: "Change value",
        explanation: "Update value", recommendation: "Change a", confidence: "high" as const,
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
      }],
      warnings: [],
    } as AIReviewResult;
    const review = await saveReview(root, report, ai);
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    return approval;
  }
  it("stages the approved patch in a separate workspace without changing the project", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    expect(staged.approvalId).toBe(approval.id);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
    expect(await readFile(path.join(root, staged.stagedFile), "utf8")).toBe("const a = 2;\n");
    expect(staged.stagedFile).toContain(".forge/patch-workspaces/");
  });
  it("does not allow the same approval to stage a second time", async () => {
    const approval = await fixture();
    const first = await stageApprovedPatch(root, approval.id);
    expect(await readFile(path.join(root, first.stagedFile), "utf8")).toBe("const a = 2;\n");
    await expect(stageApprovedPatch(root, approval.id)).rejects.toThrow(/already been used|already claimed/);
  });
  it("refuses staging when the source changed after approval", async () => {
    const approval = await fixture();
    await writeFile(path.join(root, "src/a.ts"), "const a = 3;\n");
    await expect(stageApprovedPatch(root, approval.id)).rejects.toThrow(/changed after approval|no longer applicable/);
  });

  it("reviews the staged diff and verifies source and staged hashes", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    const review = await reviewStagedPatch(root, staged.id);
    expect(review.file).toBe("src/a.ts");
    expect(review.unchanged).toBe(false);
    expect(review.diff).toContain("-const a = 1;");
    expect(review.diff).toContain("+const a = 2;");
    expect(review.diff.split("\n")).toContain("-const a = 1;");
    expect(review.diff.split("\n")).toContain("+const a = 2;");
  });
  it("rejects a staged file modified after staging", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    await writeFile(path.join(root, staged.stagedFile), "tampered");
    await expect(reviewStagedPatch(root, staged.id)).rejects.toThrow(/changed after staging/);
  });

  it("verifies the staged patch in a temporary snapshot and excludes environment files", async () => {
    const approval = await fixture();
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        check: `node -e "const fs=require('node:fs');if(!fs.readFileSync('src/a.ts','utf8').includes('a = 2'))process.exit(1);if(fs.existsSync('.env'))process.exit(2)"`,
      },
    }));
    await writeFile(path.join(root, ".env"), "SECRET=must-not-be-copied");
    const staged = await stageApprovedPatch(root, approval.id);
    const result = await verifyStagedPatch(root, staged.id, "check");
    expect(result.verification.status, result.verification.output).toBe("passed");
    expect(result.file).toBe("src/a.ts");
    expect(result.stagedSha256).toBe(staged.stagedSha256);
    expect(result.snapshotFileCount).toBeGreaterThanOrEqual(2);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
  });;

  it("verifies the captured staged snapshot even if the live project later changes", async () => {
    const approval = await fixture();
    await writeFile(path.join(root, "src/other.txt"), "captured-version");
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        check: `node -e "const fs=require('node:fs');if(fs.readFileSync('src/other.txt','utf8')!=='captured-version')process.exit(1);if(!fs.readFileSync('src/a.ts','utf8').includes('a = 2'))process.exit(2)"`,
      },
    }));
    const staged = await stageApprovedPatch(root, approval.id);
    await writeFile(path.join(root, "src/other.txt"), "changed-after-stage");
    const result = await verifyStagedPatch(root, staged.id, "check");
    expect(result.verification.status).toBe("passed");
    expect(result.snapshotFileCount).toBeGreaterThanOrEqual(3);
  });

  it("refuses verification if any file in the staged snapshot is tampered with", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    const workspaceFile = path.join(root, staged.workspacePath, "src/a.ts");
    await writeFile(workspaceFile, "tampered");
    await expect(verifyStagedPatch(root, staged.id, "test")).rejects.toThrow(/workspace changed after staging/);
  });


  it("requires the exact staged hash, backs up the source, promotes, and rolls back", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    await expect(promoteStagedPatch(root, staged.id, "reviewer", "0".repeat(64))).rejects.toThrow(/confirmation does not match/);
    const promoted = await promoteStagedPatch(root, staged.id, "reviewer", staged.stagedSha256);
    expect(promoted.promotedSha256).toBe(staged.stagedSha256);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 2;\n");
    expect(await readFile(path.join(root, promoted.backupPath), "utf8")).toBe("const a = 1;\n");
    await expect(promoteStagedPatch(root, staged.id, "reviewer", staged.stagedSha256)).rejects.toThrow(/already been promoted/);
    await rollbackStagedPatch(root, staged.id, "reviewer");
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
  });

  it("recovers a promotion interrupted before its manifest update", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    const stageRoot = path.join(root, ".forge", "patch-workspaces", staged.id);
    const manifestPath = path.join(stageRoot, "stage.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const promoted = await promoteStagedPatch(root, staged.id, "reviewer", staged.stagedSha256);
    await writeFile(manifestPath, originalManifest);
    await writeFile(path.join(stageRoot, "promotion-journal.json"), JSON.stringify({
      stageId: staged.id, file: promoted.file, reviewer: "reviewer", state: "prepared",
      sourceSha256: promoted.sourceSha256, stagedSha256: promoted.promotedSha256,
      backupPath: promoted.backupPath, backupSha256: promoted.sourceSha256,
      preparedAt: new Date().toISOString(),
    }));
    await rollbackStagedPatch(root, staged.id, "recovery-reviewer");
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
    await expect(readFile(path.join(stageRoot, "promotion-journal.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses recovery when the promotion journal does not match its stage", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    const stageRoot = path.join(root, ".forge", "patch-workspaces", staged.id);
    const manifestPath = path.join(stageRoot, "stage.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const promoted = await promoteStagedPatch(root, staged.id, "reviewer", staged.stagedSha256);
    await writeFile(manifestPath, originalManifest);
    const journalPath = path.join(stageRoot, "promotion-journal.json");
    await writeFile(journalPath, JSON.stringify({
      stageId: "patch-stage-000000000000000000000000",
      file: promoted.file, reviewer: "reviewer", state: "prepared",
      sourceSha256: promoted.sourceSha256, stagedSha256: promoted.promotedSha256,
      backupPath: promoted.backupPath, backupSha256: promoted.sourceSha256,
      preparedAt: new Date().toISOString(),
    }));
    await expect(rollbackStagedPatch(root, staged.id, "recovery-reviewer")).rejects.toThrow(/journal does not match/);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 2;\n");
    await expect(readFile(journalPath, "utf8")).resolves.toContain("patch-stage-000000000000000000000000");
  });

  it("refuses recovery when the promotion journal points to a forged backup path", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    const stageRoot = path.join(root, ".forge", "patch-workspaces", staged.id);
    const manifestPath = path.join(stageRoot, "stage.json");
    const originalManifest = await readFile(manifestPath, "utf8");
    const promoted = await promoteStagedPatch(root, staged.id, "reviewer", staged.stagedSha256);
    await writeFile(manifestPath, originalManifest);
    const journalPath = path.join(stageRoot, "promotion-journal.json");
    await writeFile(journalPath, JSON.stringify({
      stageId: staged.id, file: promoted.file, reviewer: "reviewer", state: "prepared",
      sourceSha256: promoted.sourceSha256, stagedSha256: promoted.promotedSha256,
      backupPath: ".forge/patch-workspaces/other-stage/backup/src/a.ts",
      backupSha256: promoted.sourceSha256, preparedAt: new Date().toISOString(),
    }));
    await expect(rollbackStagedPatch(root, staged.id, "recovery-reviewer")).rejects.toThrow(/journal does not match/);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 2;\n");
    await expect(readFile(journalPath, "utf8")).resolves.toContain("other-stage");
  });

  it("refuses rollback when a backup parent directory is replaced by a symlink", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    const promoted = await promoteStagedPatch(root, staged.id, "reviewer", staged.stagedSha256);
    const backupDir = path.dirname(path.join(root, promoted.backupPath));
    const originalParent = path.join(path.dirname(backupDir), "src-original");
    const outside = await mkdtemp(path.join(os.tmpdir(), "forge-outside-backup-"));
    await afterEachCleanup.push(outside);
    await mkdir(path.join(outside, "src"));
    await writeFile(path.join(outside, "src/a.ts"), "forged backup\\n");
    await rename(backupDir, originalParent);
    await symlink(path.join(outside, "src"), backupDir);
    await expect(rollbackStagedPatch(root, staged.id, "reviewer")).rejects.toThrow(/resolves outside/);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 2;\n");
  });

  it("refuses rollback if the promoted file has changed since promotion", async () => {
    const approval = await fixture();
    const staged = await stageApprovedPatch(root, approval.id);
    await promoteStagedPatch(root, staged.id, "reviewer", staged.stagedSha256);
    await writeFile(path.join(root, "src/a.ts"), "newer user work\n");
    await expect(rollbackStagedPatch(root, staged.id, "reviewer")).rejects.toThrow(/changed since promotion/);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("newer user work\n");
  });

});
