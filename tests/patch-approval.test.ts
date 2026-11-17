import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveReview } from "../src/core/review-history.js";
import { approveReviewPatch, consumePatchApproval, revokePatchApproval, verifyPatchApproval } from "../src/core/patch-approval.js";
import type { CodeReviewReport } from "../src/core/code-review.js";
import type { AIReviewResult } from "../src/core/ai-code-review.js";

describe("patch approval records", () => {
  let root = "";
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-patch-approval-"));
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
    return saveReview(root, report, ai);
  }
  it("stores an expiring approval bound to exact patch and source hashes", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer", "Looks good");
    expect(approval.reviewer).toBe("reviewer");
    expect(approval.patchSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await verifyPatchApproval(root, approval.id)).valid).toBe(true);
    expect(await readFile(path.join(root, "src/a.ts"), "utf8")).toBe("const a = 1;\n");
  });
  it("invalidates approval if the source changes after review", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    await writeFile(path.join(root, "src/a.ts"), "const a = 9;\n");
    const result = await verifyPatchApproval(root, approval.id);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/changed after approval|no longer applicable/);
  });
  it("rejects malformed stored approval records", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    const file = path.join(root, ".forge", "patch-approvals", approval.id + ".json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.expiresAt = "not-a-date";
    await writeFile(file, JSON.stringify(saved));
    await expect(verifyPatchApproval(root, approval.id)).rejects.toThrow(/invalid format/);
  });
  it("invalidates approval if the target file binding changes", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    const file = path.join(root, ".forge", "patch-approvals", approval.id + ".json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.file = "src/other.ts";
    await writeFile(file, JSON.stringify(saved));
    const result = await verifyPatchApproval(root, approval.id);
    expect(result.valid).toBe(false);
  });

  it("revokes an approval and makes verification fail", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    const revoked = await revokePatchApproval(root, approval.id);
    expect(revoked.revokedAt).toBeTruthy();
    const result = await verifyPatchApproval(root, approval.id);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/revoked/);
  });
  it("allows an approval to be consumed only once", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    const consumed = await consumePatchApproval(root, approval.id);
    expect(consumed.usedAt).toBeTruthy();
    await expect(consumePatchApproval(root, approval.id)).rejects.toThrow(/already been used|already been used or claimed/);
    const result = await verifyPatchApproval(root, approval.id);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/already been used/);
  });
  it("allows only one concurrent consumer of an approval", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    const results = await Promise.allSettled([
      consumePatchApproval(root, approval.id),
      consumePatchApproval(root, approval.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("does not allow revocation after an approval is consumed", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    await consumePatchApproval(root, approval.id);
    await expect(revokePatchApproval(root, approval.id)).rejects.toThrow(/already used or being consumed/);
  });
  it("does not allow consumption after revocation", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    await revokePatchApproval(root, approval.id);
    await expect(consumePatchApproval(root, approval.id)).rejects.toThrow(/revoked/);
  });
  it("serializes concurrent revocation and consumption", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    const results = await Promise.allSettled([
      consumePatchApproval(root, approval.id),
      revokePatchApproval(root, approval.id),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });
  it("rejects expired approvals", async () => {
    const review = await fixture();
    const approval = await approveReviewPatch(root, review.id, 1, "reviewer");
    const file = path.join(root, ".forge", "patch-approvals", approval.id + ".json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    saved.expiresAt = new Date(Date.now() - 1000).toISOString();
    await writeFile(file, JSON.stringify(saved));
    const result = await verifyPatchApproval(root, approval.id);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/);
  });
  it("rejects symlinked approval storage", async () => {
    const review = await fixture();
    const outside = path.join(root, "outside-approvals");
    await mkdir(outside);
    await symlink(outside, path.join(root, ".forge", "patch-approvals"), "dir");
    await expect(approveReviewPatch(root, review.id, 1, "reviewer")).rejects.toThrow(/must not contain symbolic links/);
  });
  it("rejects blank reviewers and unreasonable expiry", async () => {
    const review = await fixture();
    await expect(approveReviewPatch(root, review.id, 1, " ")).rejects.toThrow(/reviewer identity/);
    await expect(approveReviewPatch(root, review.id, 1, "reviewer", undefined, 1000)).rejects.toThrow(/between one minute/);
  });
});
