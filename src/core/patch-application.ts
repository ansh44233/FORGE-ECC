import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadReview } from "./review-history.js";
import { consumePatchApproval, loadPatchApproval, verifyPatchApproval } from "./patch-approval.js";
import { validateReviewPatch } from "./patch-validation.js";

export interface PatchStageRecord {
  id: string;
  approvalId: string;
  reviewId: string;
  suggestionNumber: number;
  file: string;
  stagedFile: string;
  stagedAt: string;
  sourceSha256: string;
  stagedSha256: string;
  workspacePath: string;
  workspaceSha256: string;
  snapshotFiles: number;
  snapshotBytes: number;
  promotedAt?: string;
  promotedBy?: string;
  backupPath?: string;
  backupSha256?: string;
}
function sha(value: string): string { return createHash("sha256").update(value).digest("hex"); }

const SNAPSHOT_MAX_FILES = 20_000;
const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_EXCLUDED_DIRS = new Set([".git", ".forge", ".next", ".turbo", "coverage", "node_modules", "dist", "build", ".cache", ".vercel"]);
const SNAPSHOT_SECRET_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials(?:\..*)?)$/i;
const SNAPSHOT_SECRET_EXTENSION = /\.(?:pem|key|p12|pfx)$/i;

function excludedSnapshotEntry(name: string): boolean {
  return SNAPSHOT_EXCLUDED_DIRS.has(name) || SNAPSHOT_SECRET_FILE.test(name) || SNAPSHOT_SECRET_EXTENSION.test(name);
}

async function walkSnapshot(
  root: string,
  destination?: string,
): Promise<{ files: number; bytes: number; sha256: string }> {
  let files = 0;
  let bytes = 0;
  const hash = createHash("sha256");
  async function walk(current: string, relative: string): Promise<void> {
    if (destination) await mkdir(path.join(destination, relative), { recursive: true, mode: 0o700 });
    const names = (await readdir(path.join(root, relative))).sort();
    for (const name of names) {
      if (excludedSnapshotEntry(name)) continue;
      const rel = relative ? path.join(relative, name) : name;
      const source = path.join(root, rel);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error("Project snapshots reject symbolic links; remove or replace links before staging.");
      if (info.isDirectory()) {
        await walk(root, rel);
      } else if (info.isFile()) {
        files++;
        bytes += info.size;
        if (files > SNAPSHOT_MAX_FILES) throw new Error("Project snapshot exceeds the 20,000-file limit.");
        if (bytes > SNAPSHOT_MAX_BYTES) throw new Error("Project snapshot exceeds the 256 MiB limit.");
        const content = await readFile(source);
        hash.update(rel.split(path.sep).join("/")).update("\\0").update(content).update("\\0");
        if (destination) {
          const target = path.join(destination, rel);
          await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await writeFile(target, content, { flag: "wx", mode: 0o600 });
        }
      }
    }
  }
  await walk(root, "");
  return { files, bytes, sha256: hash.digest("hex") };
}

export async function copyStagedWorkspaceSnapshot(
  source: string,
  destination: string,
): Promise<{ files: number; bytes: number; sha256: string }> {
  const resolved = await realpath(source);
  return walkSnapshot(resolved, destination);
}

export async function fingerprintStagedWorkspace(workspace: string): Promise<{ files: number; bytes: number; sha256: string }> {
  const resolved = await realpath(workspace);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Staged workspace must be a regular directory.");
  return walkSnapshot(resolved);
}
async function ensureSafeDirectory(project: string, target: string): Promise<void> {
  const relative = path.relative(project, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Staging directory must be inside the project.");
  let cursor = project;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try { await mkdir(cursor); } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const info = await lstat(cursor);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Staging path contains a symbolic link or non-directory component.");
  }
}
function parseHunks(patch: string, file: string) {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== `--- a/${file}` || lines[1] !== `+++ b/${file}`) throw new Error("Patch headers do not match the approved target.");
  const hunks: { oldStart: number; oldCount: number; newCount: number; lines: string[] }[] = [];
  let current: { oldStart: number; oldCount: number; newCount: number; lines: string[] } | undefined;
  for (const line of lines.slice(2)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (match) {
      current = { oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]), newCount: match[4] === undefined ? 1 : Number(match[4]), lines: [] };
      hunks.push(current);
    } else if (line.startsWith("\\ No newline at end of file")) {
      continue;
    } else if (line && current && [" ", "+", "-"].includes(line[0] ?? "")) {
      current.lines.push(line);
    } else if (line && !current) {
      throw new Error("Unexpected content outside patch hunks.");
    }
  }
  return hunks;
}
function applyUnifiedDiff(source: string, patch: string, file: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = source.endsWith("\n");
  const input = source.replace(/\r\n/g, "\n").split("\n");
  if (hadFinalNewline) input.pop();
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of parseHunks(patch, file)) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > input.length) throw new Error("Patch hunks overlap or exceed the source file.");
    output.push(...input.slice(cursor, start));
    cursor = start;
    let oldSeen = 0, newSeen = 0;
    for (const line of hunk.lines) {
      const marker = line[0];
      const value = line.slice(1);
      if (marker === " ") {
        if (input[cursor] !== value) throw new Error("Patch context changed during staging.");
        output.push(value); cursor++; oldSeen++; newSeen++;
      } else if (marker === "-") {
        if (input[cursor] !== value) throw new Error("Patch deletion does not match source during staging.");
        cursor++; oldSeen++;
      } else if (marker === "+") {
        output.push(value); newSeen++;
      }
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) throw new Error("Patch hunk line counts are inconsistent.");
  }
  output.push(...input.slice(cursor));
  const result = output.join(newline);
  return hadFinalNewline ? result + newline : result;
}

/** Applies an approved patch only to a new, isolated staging directory; the project remains untouched. */
export async function stageApprovedPatch(root: string, approvalId: string): Promise<PatchStageRecord> {
  const project = path.resolve(root);
  const approval = await loadPatchApproval(project, approvalId);
  const verified = await verifyPatchApproval(project, approvalId);
  if (!verified.valid) throw new Error("Patch staging refused: " + verified.reason);
  const review = await loadReview(project, approval.reviewId);
  const validation = await validateReviewPatch(project, review, approval.suggestionNumber);
  if (validation.status !== "applicable") throw new Error("Patch staging refused: " + validation.reason);
  const suggestion = review.ai?.suggestions[approval.suggestionNumber - 1];
  if (!suggestion?.patch || suggestion.file !== approval.file) throw new Error("Approved suggestion is missing or its target changed.");
  const sourcePath = path.resolve(project, approval.file);
  const relative = path.relative(project, sourcePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Patch target escapes the project.");
  const sourceReal = await realpath(sourcePath);
  const projectReal = await realpath(project);
  if (!sourceReal.startsWith(projectReal + path.sep)) throw new Error("Patch target resolves outside the project.");
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Patch target is not a regular file.");
  const source = await readFile(sourceReal, "utf8");
  if (sha(source) !== approval.sourceSha256) throw new Error("Source changed after approval; create a new review and approval.");
  const patched = applyUnifiedDiff(source, suggestion.patch, approval.file);
  const id = "patch-stage-" + randomUUID();
  const stageRoot = path.join(project, ".forge", "patch-workspaces", id);
  const workspaceRoot = path.join(stageRoot, "workspace");
  await ensureSafeDirectory(project, workspaceRoot);
  try {
    const snapshot = await walkSnapshot(project, workspaceRoot);
    const stagedTarget = path.resolve(workspaceRoot, relative);
    const stagedRelative = path.relative(workspaceRoot, stagedTarget);
    if (!stagedRelative || stagedRelative.startsWith("..") || path.isAbsolute(stagedRelative)) throw new Error("Patch target escapes the staged snapshot.");
    await mkdir(path.dirname(stagedTarget), { recursive: true, mode: 0o700 });
    await writeFile(stagedTarget, patched, { encoding: "utf8", flag: "w", mode: 0o600 });
    const finalSnapshot = await walkSnapshot(workspaceRoot);
    const record: PatchStageRecord = {
      id, approvalId, reviewId: approval.reviewId, suggestionNumber: approval.suggestionNumber,
      file: approval.file,
      stagedFile: path.relative(project, stagedTarget).split(path.sep).join("/"),
      stagedAt: new Date().toISOString(), sourceSha256: sha(source), stagedSha256: sha(patched),
      workspacePath: path.relative(project, workspaceRoot).split(path.sep).join("/"),
      workspaceSha256: finalSnapshot.sha256, snapshotFiles: finalSnapshot.files, snapshotBytes: finalSnapshot.bytes,
    };
    await writeFile(path.join(stageRoot, "stage.json"), JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await consumePatchApproval(project, approvalId);
    return record;
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}



export interface PatchStageReview {
  stageId: string;
  file: string;
  sourceSha256: string;
  stagedSha256: string;
  unchanged: boolean;
  diff: string;
}
function lineDiff(before: string, after: string): string {
  const left = before.replace(/\r\n/g, "\n").split("\n");
  const right = after.replace(/\r\n/g, "\n").split("\n");
  if (left.length > 2000 || right.length > 2000) throw new Error("Staged diff exceeds the 2,000-line review limit.");
  const rows = left.length + 1, cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) {
    table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  }
  const out = ["--- original", "+++ staged"];
  let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { out.push(" " + left[i]); i++; j++; }
    else if (j < right.length && (i >= left.length || table[i]![j + 1]! >= table[i + 1]![j]!)) { out.push("+" + right[j]); j++; }
    else { out.push("-" + left[i]); i++; }
    if (out.length > 4000) throw new Error("Staged diff exceeds the 4,000-line output limit.");
  }
  return out.join("\n");
}

/** Verifies a staged manifest and returns a bounded, read-only diff. */
export async function reviewStagedPatch(root: string, stageId: string): Promise<PatchStageReview> {
  if (!/^patch-stage-[a-f0-9-]{20,40}$/.test(stageId) || stageId.includes("..")) throw new Error("Invalid patch stage identifier.");
  const project = path.resolve(root);
  const projectReal = await realpath(project);
  const stageRoot = path.join(project, ".forge", "patch-workspaces", stageId);
  const stageReal = await realpath(stageRoot);
  if (!stageReal.startsWith(projectReal + path.sep)) throw new Error("Patch stage resolves outside the project.");
  const manifestPath = path.join(stageRoot, "stage.json");
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error("Stage manifest must be a regular file.");
  const record = JSON.parse(await readFile(manifestPath, "utf8")) as PatchStageRecord;
  if (record.id !== stageId || typeof record.file !== "string" || typeof record.stagedFile !== "string" ||
      typeof record.sourceSha256 !== "string" || typeof record.stagedSha256 !== "string") throw new Error("Stage manifest is invalid.");
  const sourcePath = path.resolve(project, record.file);
  const stagedPath = path.resolve(project, record.stagedFile);
  for (const candidate of [sourcePath, stagedPath]) {
    const relative = path.relative(project, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Stage review path escapes the project.");
  }
  const [sourceReal, stagedReal] = await Promise.all([realpath(sourcePath), realpath(stagedPath)]);
  if (!sourceReal.startsWith(projectReal + path.sep) || !stagedReal.startsWith(stageReal + path.sep)) throw new Error("Stage review target resolves outside its expected directory.");
  for (const candidate of [sourcePath, stagedPath]) {
    const info = await lstat(candidate);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Stage review only supports regular files.");
  }
  const [source, staged] = await Promise.all([readFile(sourceReal, "utf8"), readFile(stagedReal, "utf8")]);
  const sourceSha256 = sha(source), stagedSha256 = sha(staged);
  if (sourceSha256 !== record.sourceSha256) throw new Error("Original source changed after staging; regenerate and approve a fresh patch.");
  if (stagedSha256 !== record.stagedSha256) throw new Error("Staged file changed after staging; do not promote this workspace.");
  return { stageId, file: record.file, sourceSha256, stagedSha256, unchanged: source === staged, diff: lineDiff(source, staged) };
}


export interface PatchPromotionRecord {
  stageId: string;
  file: string;
  promotedAt: string;
  promotedBy: string;
  sourceSha256: string;
  promotedSha256: string;
  backupPath: string;
}

/** Promotes one reviewed staged file only after an explicit hash confirmation. */
export async function promoteStagedPatch(
  root: string,
  stageId: string,
  reviewer: string,
  expectedStagedSha256: string,
): Promise<PatchPromotionRecord> {
  const name = reviewer.trim().slice(0, 80);
  if (!name) throw new Error("A non-empty promotion reviewer identity is required.");
  if (!/^[a-f0-9]{64}$/.test(expectedStagedSha256)) throw new Error("Promotion requires the exact staged SHA-256 confirmation.");
  const project = path.resolve(root);
  const projectRealForStage = await realpath(project);
  const stageRootForStage = path.join(project, ".forge", "patch-workspaces", stageId);
  const stageRealForStage = await realpath(stageRootForStage);
  if (!stageRealForStage.startsWith(projectRealForStage + path.sep)) throw new Error("Promotion stage resolves outside the project.");
  const earlyManifest = JSON.parse(await readFile(path.join(stageRootForStage, "stage.json"), "utf8")) as PatchStageRecord;
  if (earlyManifest.promotedAt) throw new Error("This staged patch has already been promoted.");
  const reviewed = await reviewStagedPatch(project, stageId);
  if (reviewed.stagedSha256 !== expectedStagedSha256) throw new Error("Promotion confirmation does not match the staged file hash.");
  const projectReal = await realpath(project);
  const stageRoot = path.join(project, ".forge", "patch-workspaces", stageId);
  const stageReal = await realpath(stageRoot);
  if (!stageReal.startsWith(projectReal + path.sep)) throw new Error("Promotion stage resolves outside the project.");
  const lock = path.join(stageRoot, ".promotion-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("This staged patch is already being promoted or rolled back.");
    }
    throw error;
  }
  let temporary = "";
  try {
    const manifestPath = path.join(stageRoot, "stage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PatchStageRecord;
    if (manifest.promotedAt) throw new Error("This staged patch has already been promoted.");
    const workspace = path.resolve(project, manifest.workspacePath);
    const workspaceFingerprint = await fingerprintStagedWorkspace(workspace);
    if (workspaceFingerprint.sha256 !== manifest.workspaceSha256) throw new Error("Staged workspace changed after staging; promotion refused.");
    const target = path.resolve(project, manifest.file);
    const relative = path.relative(project, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Promotion target escapes the project.");
    const targetReal = await realpath(target);
    if (!targetReal.startsWith(projectReal + path.sep)) throw new Error("Promotion target resolves outside the project.");
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw new Error("Promotion target must be a regular file.");
    const current = await readFile(targetReal);
    const currentHash = sha(current.toString("utf8"));
    if (currentHash !== manifest.sourceSha256 || currentHash !== reviewed.sourceSha256) {
      throw new Error("Original file changed since staging; create a fresh review and approval.");
    }
    const stagedPath = path.resolve(project, manifest.stagedFile);
    const stagedInfo = await lstat(stagedPath);
    if (stagedInfo.isSymbolicLink() || !stagedInfo.isFile()) throw new Error("Staged target must be a regular file.");
    const staged = await readFile(stagedPath);
    if (sha(staged.toString("utf8")) !== expectedStagedSha256) throw new Error("Staged file changed before promotion.");
    const backupRelative = path.posix.join(".forge", "patch-workspaces", stageId, "backup", relative.split(path.sep).join("/"));
    const backup = path.resolve(project, backupRelative);
    await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    await writeFile(backup, current, { flag: "wx", mode: 0o600 });
    temporary = path.join(path.dirname(target), ".forge-promote-" + randomUUID() + ".tmp");
    await writeFile(temporary, staged, { flag: "wx", mode: 0o600 });
    const journalPath = path.join(stageRoot, "promotion-journal.json");
    const journal = { stageId, file: manifest.file, reviewer: name, state: "prepared" as const, sourceSha256: manifest.sourceSha256, stagedSha256: expectedStagedSha256, backupPath: backupRelative, backupSha256: manifest.sourceSha256, preparedAt: new Date().toISOString() };
    const journalTemp = path.join(stageRoot, ".promotion-journal-" + randomUUID() + ".tmp");
    await writeFile(journalTemp, JSON.stringify(journal, null, 2) + "\\n", { flag: "wx", mode: 0o600 });
    await rename(journalTemp, journalPath);
    const lastCheck = await readFile(target);
    if (sha(lastCheck.toString("utf8")) !== manifest.sourceSha256) throw new Error("Original file changed during promotion; no changes were applied.");
    await rename(temporary, target);
    temporary = "";
    const promotedAt = new Date().toISOString();
    const updated: PatchStageRecord = {
      ...manifest, promotedAt, promotedBy: name,
      backupPath: backupRelative, backupSha256: manifest.sourceSha256,
    };
    const manifestTemp = path.join(stageRoot, ".stage-" + randomUUID() + ".tmp");
    try {
      await writeFile(manifestTemp, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(manifestTemp, manifestPath);
      await rm(journalPath, { force: true });
    } catch (error) {
      await rm(manifestTemp, { force: true }).catch(() => undefined);
      const rollbackTemp = path.join(path.dirname(target), ".forge-rollback-" + randomUUID() + ".tmp");
      await writeFile(rollbackTemp, current, { flag: "wx", mode: 0o600 });
      await rename(rollbackTemp, target);
      throw error;
    }
    return {
      stageId, file: manifest.file, promotedAt, promotedBy: name,
      sourceSha256: manifest.sourceSha256, promotedSha256: expectedStagedSha256,
      backupPath: backupRelative,
    };
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Restores the original file only if the promoted contents are still untouched. */
export async function rollbackStagedPatch(root: string, stageId: string, reviewer: string): Promise<void> {
  const name = reviewer.trim().slice(0, 80);
  if (!name) throw new Error("A non-empty rollback reviewer identity is required.");
  if (!/^patch-stage-[a-f0-9-]{20,40}$/.test(stageId) || stageId.includes("..")) throw new Error("Invalid patch stage identifier.");
  const project = path.resolve(root);
  const stageRoot = path.join(project, ".forge", "patch-workspaces", stageId);
  const stageReal = await realpath(stageRoot);
  const projectReal = await realpath(project);
  if (!stageReal.startsWith(projectReal + path.sep)) throw new Error("Rollback stage resolves outside the project.");
  const lock = path.join(stageRoot, ".promotion-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new Error("This staged patch is already being promoted or rolled back.");
    throw error;
  }
  try {
    const manifestPath = path.join(stageRoot, "stage.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PatchStageRecord;
    const journalPath = path.join(stageRoot, "promotion-journal.json");
    let journal: {
      stageId: string; file: string; reviewer: string; state: string;
      sourceSha256: string; stagedSha256: string; backupPath: string;
      backupSha256: string; preparedAt: string;
    } | undefined;
    try {
      const journalInfo = await lstat(journalPath);
      if (journalInfo.isSymbolicLink() || !journalInfo.isFile() || journalInfo.size > 16 * 1024) {
        throw new Error("Promotion journal must be a regular file no larger than 16 KiB.");
      }
      const parsed: unknown = JSON.parse(await readFile(journalPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Promotion journal is malformed.");
      const value = parsed as Record<string, unknown>;
      const expectedBackupPath = path.posix.join(".forge", "patch-workspaces", stageId, "backup", path.relative(project, path.resolve(project, manifest.file)).split(path.sep).join("/"));
      const validHash = (candidate: unknown): candidate is string => typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate);
      if (
        value.stageId !== stageId || value.file !== manifest.file ||
        value.state !== "prepared" ||
        typeof value.reviewer !== "string" || !value.reviewer.trim() || value.reviewer.length > 80 ||
        !validHash(value.sourceSha256) || value.sourceSha256 !== manifest.sourceSha256 ||
        !validHash(value.stagedSha256) || value.stagedSha256 !== manifest.stagedSha256 ||
        value.backupPath !== expectedBackupPath ||
        !validHash(value.backupSha256) || value.backupSha256 !== manifest.sourceSha256 ||
        typeof value.preparedAt !== "string" || !Number.isFinite(Date.parse(value.preparedAt))
      ) throw new Error("Promotion journal does not match the stage manifest; recovery refused.");
      if (manifest.promotedAt && (
        manifest.backupPath !== value.backupPath ||
        manifest.backupSha256 !== value.backupSha256 ||
        manifest.promotedBy !== value.reviewer
      )) throw new Error("Promotion journal conflicts with the completed promotion manifest; recovery refused.");
      journal = value as typeof journal;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    const file = manifest.promotedAt ? manifest.file : journal?.file;
    const backupPath = manifest.backupPath ?? journal?.backupPath;
    const backupSha256 = manifest.backupSha256 ?? journal?.backupSha256;
    const expectedPromotedHash = journal?.stagedSha256 ?? manifest.stagedSha256;
    if (!file || !backupPath || !backupSha256 || (!manifest.promotedAt && !journal)) throw new Error("This stage has no completed promotion or recoverable promotion journal.");
    const target = path.resolve(project, file);
    const backup = path.resolve(project, backupPath);
    for (const candidate of [target, backup]) {
      const relative = path.relative(project, candidate);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Rollback path escapes the project.");
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("Rollback only supports regular files.");
    }
    const [targetReal, backupReal] = await Promise.all([realpath(target), realpath(backup)]);
    if (!targetReal.startsWith(projectReal + path.sep) || !backupReal.startsWith(stageReal + path.sep)) {
      throw new Error("Rollback target or backup resolves outside its trusted directory.");
    }
    const [current, original] = await Promise.all([readFile(targetReal), readFile(backupReal)]);
    const currentHash = sha(current.toString("utf8"));
    if (currentHash === backupSha256) {
      if (journal && !manifest.promotedAt) { await rm(journalPath, { force: true }); throw new Error("Promotion had not changed the target; abandoned journal cleared."); }
      throw new Error("Target already contains the original file; refusing an unnecessary rollback.");
    }
    if (currentHash !== expectedPromotedHash) throw new Error("Promoted file has changed since promotion; refusing to overwrite newer work.");
    if (sha(original.toString("utf8")) !== backupSha256) throw new Error("Promotion backup failed integrity verification.");
    const temp = path.join(path.dirname(target), ".forge-rollback-" + randomUUID() + ".tmp");
    await writeFile(temp, original, { flag: "wx", mode: 0o600 });
    await rename(temp, target);
    const updated: PatchStageRecord = { ...manifest };
    delete updated.promotedAt;
    delete updated.promotedBy;
    delete updated.backupPath;
    delete updated.backupSha256;
    const manifestTemp = path.join(stageRoot, ".stage-" + randomUUID() + ".tmp");
    await writeFile(manifestTemp, JSON.stringify(updated, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(manifestTemp, manifestPath);
    await rm(journalPath, { force: true });
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => undefined);
  }
}
