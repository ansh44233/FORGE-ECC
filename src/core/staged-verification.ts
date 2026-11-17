import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installVerificationDependencies, runVerification, type DependencyInstallResult, type VerificationResult } from "./verification.js";
import { copyStagedWorkspaceSnapshot, fingerprintStagedWorkspace, type PatchStageRecord } from "./patch-application.js";
import { runContainerVerification } from "./container-sandbox.js";
import { loadSandboxPolicy } from "./sandbox-policy.js";

export interface StagedVerificationResult {
  id: string;
  stageId: string;
  file: string;
  sourceSha256: string;
  stagedSha256: string;
  snapshotFileCount: number;
  snapshotBytes: number;
  verification: VerificationResult;
  dependencyInstall: DependencyInstallResult | null;
  verifiedAt: string;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Runs one explicitly selected npm script against a temporary copy of the fingerprinted staged workspace.
 * Project scripts still execute on the local host; this is not an OS-level sandbox.
 */
export async function verifyStagedPatch(
  projectPath: string,
  stageId: string,
  script: string,
  options: { timeoutMs?: number; installDependencies?: boolean; installTimeoutMs?: number; sandboxImage?: string; runtimePath?: string; requireRootless?: boolean; securityProfile?: "balanced" | "hardened" | "rootless-required"; sandboxPolicyPath?: string } = {},
): Promise<StagedVerificationResult> {
  const project = await realpath(path.resolve(projectPath));
  if (options.sandboxPolicyPath && !options.sandboxImage) throw new Error("--policy requires --sandbox-image container execution.");
  const policyResult = options.sandboxPolicyPath ? await loadSandboxPolicy(options.sandboxPolicyPath) : undefined;
  if (policyResult && !policyResult.valid) throw new Error("Invalid sandbox policy: " + policyResult.errors.join(" "));
  const sandboxPolicy = policyResult?.valid ? policyResult.policy : undefined;
  if (sandboxPolicy && options.securityProfile && sandboxPolicy.profile !== options.securityProfile) throw new Error("The --profile value must match the profile declared in --policy.");
  if (!/^patch-stage-[a-f0-9-]{20,40}$/.test(stageId) || stageId.includes("..")) throw new Error("Invalid patch stage identifier.");
  const stageRoot = path.join(project, ".forge", "patch-workspaces", stageId);
  const stageReal = await realpath(stageRoot);
  if (!stageReal.startsWith(project + path.sep)) throw new Error("Patch stage resolves outside the project.");
  const manifestPath = path.join(stageReal, "stage.json");
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error("Stage manifest must be a regular file.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PatchStageRecord;
  if (manifest.id !== stageId || typeof manifest.workspacePath !== "string" ||
      typeof manifest.workspaceSha256 !== "string" || typeof manifest.stagedSha256 !== "string" ||
      typeof manifest.file !== "string" || typeof manifest.stagedFile !== "string" ||
      typeof manifest.sourceSha256 !== "string" || typeof manifest.snapshotFiles !== "number" ||
      typeof manifest.snapshotBytes !== "number" || !Number.isSafeInteger(manifest.snapshotFiles) ||
      !Number.isSafeInteger(manifest.snapshotBytes) || manifest.snapshotFiles < 1 || manifest.snapshotBytes < 0) {
    throw new Error("Stage manifest does not contain a verified workspace snapshot.");
  }
  const workspacePath = path.resolve(project, manifest.workspacePath);
  const workspaceRelative = path.relative(stageReal, workspacePath);
  if (!workspaceRelative || workspaceRelative.startsWith("..") || path.isAbsolute(workspaceRelative)) throw new Error("Staged workspace path escapes its stage directory.");
  const workspaceInfo = await lstat(workspacePath);
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) throw new Error("Staged workspace must be a regular directory.");
  const workspaceReal = await realpath(workspacePath);
  if (!workspaceReal.startsWith(stageReal + path.sep)) throw new Error("Staged workspace resolves outside its stage directory.");
  const snapshotFingerprint = await fingerprintStagedWorkspace(workspaceReal);
  if (snapshotFingerprint.sha256 !== manifest.workspaceSha256 ||
      snapshotFingerprint.files !== manifest.snapshotFiles || snapshotFingerprint.bytes !== manifest.snapshotBytes) {
    throw new Error("Staged workspace changed after staging; refusing verification.");
  }
  const stagedSource = path.resolve(project, manifest.stagedFile);
  const stagedRelative = path.relative(workspaceReal, stagedSource);
  if (!stagedRelative || stagedRelative.startsWith("..") || path.isAbsolute(stagedRelative)) throw new Error("Staged patch file escapes the workspace.");
  const stagedInfo = await lstat(stagedSource);
  if (stagedInfo.isSymbolicLink() || !stagedInfo.isFile()) throw new Error("Staged patch target must be a regular file.");
  const stagedContent = await readFile(stagedSource);
  if (digest(stagedContent) !== manifest.stagedSha256) throw new Error("Staged patch changed while preparing verification.");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "forge-staged-verify-"));
  const snapshot = path.join(temporaryRoot, "workspace");
  try {
    const counts = await copyStagedWorkspaceSnapshot(workspaceReal, snapshot);
    if (counts.sha256 !== manifest.workspaceSha256) throw new Error("Temporary verification copy does not match the approved staged snapshot.");
    let dependencyInstall: DependencyInstallResult | null = null;
    if (options.installDependencies) {
      dependencyInstall = await installVerificationDependencies(snapshot, options.installTimeoutMs === undefined ? {} : { timeoutMs: options.installTimeoutMs });
      if (dependencyInstall.status !== "passed") {
        throw new Error("Dependency preparation " + dependencyInstall.status + " (exit code " + dependencyInstall.exitCode + "). " + dependencyInstall.output);
      }
    }
    const verification = options.sandboxImage
      ? await runContainerVerification(snapshot, script, options.sandboxImage, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.runtimePath === undefined ? {} : { runtimePath: options.runtimePath }),
          ...(options.requireRootless === undefined ? {} : { requireRootless: options.requireRootless }),
          ...(options.securityProfile === undefined ? {} : { securityProfile: options.securityProfile }),
          ...(sandboxPolicy === undefined ? {} : { sandboxPolicy }),
        })
      : await runVerification(snapshot, script, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
    const id = "patch-verify-" + verification.id.slice("verify-".length);
    return {
      id, stageId, file: manifest.file,
      sourceSha256: manifest.sourceSha256,
      stagedSha256: manifest.stagedSha256,
      snapshotFileCount: counts.files,
      snapshotBytes: counts.bytes,
      verification,
      dependencyInstall,
      verifiedAt: new Date().toISOString(),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
