import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "./review-history.js";
import { validateReviewPatch } from "./patch-validation.js";

export interface PatchApprovalRecord {
  id: string;
  reviewId: string;
  suggestionNumber: number;
  file: string;
  reviewer: string;
  reason?: string;
  approvedAt: string;
  expiresAt: string;
  patchSha256: string;
  sourceSha256: string;
  revokedAt?: string;
  usedAt?: string;
}
const ID = /^patch-approval-[a-f0-9-]{20,40}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
async function safeApprovalDirectory(root: string): Promise<string> {
  const project = await realpath(path.resolve(root));
  let current = project;
  for (const part of [".forge", "patch-approvals"]) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Patch approval storage must not contain symbolic links or non-directory components.");
  }
  return current;
}
function validateId(id: string): void { if (!ID.test(id) || id.includes("..")) throw new Error("Invalid patch approval identifier."); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export async function approveReviewPatch(
  root: string,
  reviewId: string,
  suggestionNumber: number,
  reviewer: string,
  reason?: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<PatchApprovalRecord> {
  const name = reviewer.trim().slice(0, 80);
  if (!name) throw new Error("A non-empty reviewer identity is required.");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 7 * 24 * 60 * 60 * 1000) throw new Error("Approval expiry must be between one minute and seven days.");
  const review = await loadReview(root, reviewId);
  const validation = await validateReviewPatch(root, review, suggestionNumber);
  if (validation.status !== "applicable") throw new Error("Patch cannot be approved: " + validation.reason);
  const suggestion = review.ai?.suggestions[suggestionNumber - 1];
  if (!suggestion?.patch) throw new Error("The selected review suggestion has no patch.");
  const target = path.resolve(root, suggestion.file);
  const source = await readFile(target, "utf8");
  const approvedAt = new Date();
  const record: PatchApprovalRecord = {
    id: "patch-approval-" + randomUUID(),
    reviewId,
    suggestionNumber,
    file: suggestion.file,
    reviewer: name,
    ...(reason?.trim() ? { reason: reason.trim().slice(0, 1000) } : {}),
    approvedAt: approvedAt.toISOString(),
    expiresAt: new Date(approvedAt.getTime() + ttlMs).toISOString(),
    patchSha256: digest(suggestion.patch),
    sourceSha256: digest(source),
  };
  const dir = await safeApprovalDirectory(root);
  const destination = path.join(dir, record.id + ".json");
  const temporary = path.join(dir, "." + record.id + "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return record;
}

export async function loadPatchApproval(root: string, id: string): Promise<PatchApprovalRecord> {
  validateId(id);
  const dir = await safeApprovalDirectory(root);
  const approvalPath = path.join(dir, id + ".json");
  const info = await lstat(approvalPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Stored patch approval must be a regular file.");
  const parsed: unknown = JSON.parse(await readFile(approvalPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || !("id" in parsed) || parsed.id !== id ||
      !("reviewId" in parsed) || typeof parsed.reviewId !== "string" ||
      !("patchSha256" in parsed) || typeof parsed.patchSha256 !== "string" ||
      !("sourceSha256" in parsed) || typeof parsed.sourceSha256 !== "string" ||
      !("file" in parsed) || typeof parsed.file !== "string" || !parsed.file.trim() ||
      !("suggestionNumber" in parsed) || typeof parsed.suggestionNumber !== "number" || !Number.isSafeInteger(parsed.suggestionNumber) || parsed.suggestionNumber < 1 ||
      !("reviewer" in parsed) || typeof parsed.reviewer !== "string" || !parsed.reviewer.trim() ||
      !("approvedAt" in parsed) || typeof parsed.approvedAt !== "string" || !Number.isFinite(Date.parse(parsed.approvedAt)) ||
      !("expiresAt" in parsed) || typeof parsed.expiresAt !== "string" || !Number.isFinite(Date.parse(parsed.expiresAt)) ||
      !/^[a-f0-9]{64}$/.test(parsed.patchSha256) || !/^[a-f0-9]{64}$/.test(parsed.sourceSha256)) {
    throw new Error("Stored patch approval has an invalid format.");
  }
  return parsed as PatchApprovalRecord;
}

export async function revokePatchApproval(root: string, id: string): Promise<PatchApprovalRecord> {
  const dir = await safeApprovalDirectory(root);
  const marker = path.join(dir, id + ".used");
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      const existing = await loadPatchApproval(root, id);
      if (existing.revokedAt) return existing;
      throw new Error("Patch approval is already used or being consumed; it cannot be revoked.");
    }
    throw error;
  }
  const approval = await loadPatchApproval(root, id);
  const revoked: PatchApprovalRecord = { ...approval, revokedAt: new Date().toISOString() };
  const destination = path.join(dir, id + ".json");
  const temporary = path.join(dir, "." + id + "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(revoked, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    // Keep the marker: a failed revocation fails closed rather than reopening approval.
    throw error;
  }
  return revoked;
}

/** Atomically consumes an approval. The exclusive marker makes concurrent consumers fail closed. */
export async function consumePatchApproval(root: string, id: string): Promise<PatchApprovalRecord> {
  const verified = await verifyPatchApproval(root, id);
  if (!verified.valid) throw new Error("Patch approval cannot be consumed: " + verified.reason);
  const approval = await loadPatchApproval(root, id);
  const dir = await safeApprovalDirectory(root);
  const marker = path.join(dir, id + ".used");
  try {
    await mkdir(marker, { mode: 0o700 });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Patch approval has already been used or claimed by another operation.");
    }
    throw error;
  }
  const consumed: PatchApprovalRecord = { ...approval, usedAt: new Date().toISOString() };
  const destination = path.join(dir, id + ".json");
  const temporary = path.join(dir, "." + id + "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(consumed, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    // Keep the marker: a partially completed consume must fail closed.
    throw error;
  }
  return consumed;
}

export async function verifyPatchApproval(root: string, id: string): Promise<{ valid: boolean; reason: string }> {
  const approval = await loadPatchApproval(root, id);
  if (approval.revokedAt) return { valid: false, reason: "Approval has been revoked; request a new approval." };
  if (approval.usedAt) return { valid: false, reason: "Approval has already been used; request a new approval." };
  try {
    await lstat(path.join(await safeApprovalDirectory(root), id + ".used"));
    return { valid: false, reason: "Approval is already claimed or its state transition did not complete; request a new approval." };
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  if (Date.now() >= Date.parse(approval.expiresAt)) return { valid: false, reason: "Approval has expired; request a new review." };
  const review = await loadReview(root, approval.reviewId);
  const suggestion = review.ai?.suggestions[approval.suggestionNumber - 1];
  if (!suggestion?.patch || suggestion.file !== approval.file || digest(suggestion.patch) !== approval.patchSha256) return { valid: false, reason: "The saved patch or target file differs from the approved patch." };
  const validation = await validateReviewPatch(root, review, approval.suggestionNumber);
  if (validation.status !== "applicable") return { valid: false, reason: "Patch is no longer applicable: " + validation.reason };
  const source = await readFile(path.resolve(root, approval.file), "utf8");
  if (digest(source) !== approval.sourceSha256) return { valid: false, reason: "The target file changed after approval; request a fresh review and approval." };
  return { valid: true, reason: "Approval is current and bound to the exact patch and source-file contents. No files were modified." };
}
