import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { VerificationResult } from "./verification.js";
import { getSandboxSecurityProfile, type SandboxSecurityProfileName } from "./sandbox-security-profiles.js";
import { validateSandboxPolicy, type SandboxPolicy } from "./sandbox-policy.js";

const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 10 * 60_000;
const IMAGE_DIGEST = /^.+@sha256:[a-f0-9]{64}$/;

export interface ContainerVerificationOptions {
  timeoutMs?: number;
  runtimePath?: string;
  requireRootless?: boolean;
  securityProfile?: SandboxSecurityProfileName;
  sandboxPolicy?: SandboxPolicy;
}

/** Returns true/false for a recognized Docker rootless security option, otherwise null. */
export function detectDockerRootless(securityOptionsOutput: string): boolean | null {
  let values: unknown;
  try { values = JSON.parse(securityOptionsOutput); } catch { return null; }
  if (!Array.isArray(values) || values.some(value => typeof value !== "string")) return null;
  const options = values as string[];
  if (options.some(value => /(?:^|[, ])name=rootless(?:$|[, ])/i.test(value))) return true;
  if (options.length > 0) return false;
  return null;
}

export function buildContainerRunArgs(
  workspace: string,
  image: string,
  script: string,
  containerName: string,
  profile: ReturnType<typeof getSandboxSecurityProfile> = getSandboxSecurityProfile("balanced"),
  policy?: SandboxPolicy,
): string[] {
  if (!IMAGE_DIGEST.test(image)) throw new Error("Sandbox image must be pinned by an immutable sha256 digest (image@sha256:...).");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/.test(script) || /^pre|^post/.test(script)) {
    throw new Error("Choose a valid, explicit package script name.");
  }
  if (workspace.includes(",")) throw new Error("Sandbox workspace paths cannot contain commas.");
  const copyAndRun = [
    "const fs=require('node:fs');const path=require('node:path');",
    "const blocked=/(^|[. _-])(env|secret|secrets|credential|credentials|private|token|password)([. _-]|$)/i;",
    "const excluded=new Set(['.git','.forge','.ssh','.aws','.azure','.kube','.docker','.gnupg','.npmrc','.pypirc','.netrc']);",
    "const filter=src=>{const info=fs.lstatSync(src);if(info.isSymbolicLink())return false;const rel=path.relative('/snapshot',src);if(!rel)return true;const parts=rel.split(path.sep).filter(Boolean);return !parts.some(name=>excluded.has(name.toLowerCase())||blocked.test(name)||/\\.(pem|key|p12|pfx|keystore)$/i.test(name)||/^(id_rsa|id_ed25519|authorized_keys)$/i.test(name));};",
    "fs.cpSync('/snapshot','/workspace',{recursive:true,filter});",
    "const r=require('node:child_process').spawnSync('npm',['run-script','--ignore-scripts',process.argv[1]],{cwd:'/workspace',stdio:'inherit'});process.exit(r.status===null?1:r.status);",
  ].join("");
  return [
    "run", "--rm", "--pull=never", "--name", containerName, "--label", "com.forge.managed=true",
    "--network=none", "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges", "--pids-limit=" + String(policy?.maxProcesses ?? profile.maxProcesses),
    "--memory=" + (policy?.maxMemory ?? profile.maxMemory), "--memory-swap=" + (policy?.maxMemory ?? profile.maxMemory), "--cpus=" + String(policy?.maxCpus ?? profile.maxCpus), "--ulimit", "nofile=1024:1024",
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777",
    "--tmpfs", "/workspace:rw,nosuid,nodev,size=1g,mode=1777",
    "--env", "CI=1", "--env", "NODE_ENV=test", "--env", "FORGE_VERIFICATION=1", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
    "--user", typeof process.getuid === "function" && typeof process.getgid === "function" ? process.getuid() + ":" + process.getgid() : "1000:1000",
    "--mount", "type=bind,source=" + workspace + ",target=/snapshot,readonly",
    "--workdir", "/workspace", "--entrypoint", "node",
    image, "-e", copyAndRun, script,
  ];
}

async function projectRoot(inputPath: string, script: string): Promise<string> {
  const root = await realpath(path.resolve(inputPath));
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("Sandbox target must be a real directory.");
  const manifestPath = path.join(root, "package.json");
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error("package.json must be a regular, non-symlink file.");
  const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json must contain a JSON object.");
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts) ||
      typeof (scripts as Record<string, unknown>)[script] !== "string") {
    throw new Error("Selected script is not defined in package.json.");
  }
  return root;
}


function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onTimeout?: () => Promise<void>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; truncated: boolean; error?: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const chunks: string[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    const windows = process.platform === "win32";
    const child = spawn(command, args, {
      cwd, shell: false,
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: !windows,
    });
    const append = (chunk: Buffer | string) => {
      const value = chunk.toString();
      const remaining = MAX_OUTPUT - size;
      if (remaining > 0) {
        chunks.push(value.slice(0, remaining));
        size += Math.min(value.length, remaining);
      }
      if (value.length > remaining) truncated = true;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const finish = (result: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output: chunks.join(""), truncated, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void (async () => { try { await onTimeout?.(); } catch { /* best-effort container stop */ }
      if (!windows && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM"); })();
    }, timeoutMs);
    child.once("error", error => finish({ code: null, signal: null, error: error.message }));
    child.once("close", (code, signal) => finish({ code, signal }));
  });
}

/**
 * Executes an explicitly selected project script in a pre-pulled, digest-pinned
 * container with no network, a read-only root filesystem, dropped capabilities,
 * PID/memory/CPU limits, and only the temporary workspace mounted writable.
 * The caller must have explicitly opted in to container execution.
 */
export async function runContainerVerification(
  inputPath: string,
  script: string,
  image: string,
  options: ContainerVerificationOptions = {},
): Promise<VerificationResult> {
  const root = await projectRoot(inputPath, script);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT) {
    throw new Error("Timeout must be between 1,000 and 600,000 milliseconds.");
  }
  if (!IMAGE_DIGEST.test(image)) throw new Error("Sandbox image must be pinned by an immutable sha256 digest (image@sha256:...).");
  const policyResult = options.sandboxPolicy ? validateSandboxPolicy(options.sandboxPolicy) : null;
  if (policyResult && !policyResult.valid) {
    throw new Error("Invalid sandbox policy: " + policyResult.errors.join(" "));
  }
  const policy = policyResult?.valid ? policyResult.policy : undefined;
  if (options.securityProfile && policy && options.securityProfile !== policy.profile) {
    throw new Error("Security profile must match the profile declared in the sandbox policy.");
  }
  const profile = getSandboxSecurityProfile(options.securityProfile ?? policy?.profile ?? "balanced");
  const requireRootless = options.requireRootless === true || profile.requireRootless || policy?.requireRootless === true;
  const runtime = options.runtimePath ?? "docker";
  const inspect = await runProcess(runtime, ["image", "inspect", image], root, 15_000);
  if (inspect.error) throw new Error("Could not start container runtime: " + inspect.error);
  if (inspect.code !== 0) throw new Error("Pinned sandbox image is not available locally. Pull and verify it separately; FORGE never pulls images automatically. " + inspect.output);
  const security = await runProcess(runtime, ["info", "--format", "{{json .SecurityOptions}}"], root, 15_000);
  if (security.error || security.code !== 0) throw new Error("Could not inspect container runtime security options; refusing container verification. " + (security.output || security.error || ""));
  const rootless = detectDockerRootless(security.output.trim());
  if (requireRootless && rootless !== true) {
    throw new Error(rootless === false
      ? "Rootless container runtime is required, but the selected Docker daemon is rootful."
      : "Rootless container runtime status could not be verified; refusing verification.");
  }
  const startedAt = new Date();
  const containerName = "forge-verify-" + randomUUID().replace(/-/g, "").slice(0, 20);
  const args = buildContainerRunArgs(root, image, script, containerName, profile, policy);
  let cleanupWarning = "";
  const result = await runProcess(runtime, args, root, timeoutMs, async () => {
    const stopped = await runProcess(runtime, ["stop", "--time", "2", containerName], root, 5_000);
    if (stopped.error || stopped.code !== 0 || stopped.timedOut) {
      const removed = await runProcess(runtime, ["rm", "--force", containerName], root, 5_000);
      if (removed.error || removed.code !== 0 || removed.timedOut) {
        cleanupWarning = "FORGE cleanup warning: stop and force-remove both failed; inspect the container runtime for a possibly running verification container.";
      }
    }
  });
  const finishedAt = new Date();
  result.output = "[FORGE profile] " + profile.name + "\\n[FORGE compliance] network=" + profile.network + ", readOnlyRoot=" + String(profile.readOnlyRoot) + ", capDrop=" + (profile.dropAllCapabilities ? "ALL" : "NONE") + ", noNewPrivileges=" + String(profile.noNewPrivileges) + ", memory=" + (policy?.maxMemory ?? profile.maxMemory) + ", cpus=" + String(policy?.maxCpus ?? profile.maxCpus) + ", pids=" + String(policy?.maxProcesses ?? profile.maxProcesses) + "\\n[FORGE runtime] Rootless daemon: " + (rootless === true ? "yes" : rootless === false ? "no" : "unknown") + "\\n" + result.output;
  if (result.error) result.output += "\\nFORGE could not start container runtime: " + result.error;
  if (cleanupWarning) result.output += "\\n" + cleanupWarning;
  return {
    id: "verify-container-" + startedAt.getTime().toString(36) + "-" + randomUUID().slice(0, 6),
    projectPath: root,
    script,
    command: runtime + " " + args.map(value => JSON.stringify(value)).join(" "),
    status: result.error ? "spawn_error" : result.timedOut ? "timed_out" : result.code === 0 ? "passed" : "failed",
    exitCode: result.code,
    signal: result.signal,
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    output: result.output,
    outputTruncated: result.truncated,
  };
}
