import { spawn } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export type VerificationStatus = "passed" | "failed" | "timed_out" | "spawn_error";
export interface AvailableCheck { name: string; command: string; packageManager: "npm"; }
export interface VerificationResult {
  id: string;
  projectPath: string;
  script: string;
  command: string;
  status: VerificationStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  output: string;
  outputTruncated: boolean;
}
const MAX_OUTPUT = 64 * 1024;
const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 10 * 60_000;
const SCRIPT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/;

async function verifiedProjectRoot(inputPath: string): Promise<string> {
  const root = await realpath(path.resolve(inputPath));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw new Error("Verification target must be a real directory.");
  const manifest = path.join(root, "package.json");
  const manifestInfo = await lstat(manifest);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error("package.json must be a regular, non-symlink file.");
  return root;
}

async function packageScripts(root: string): Promise<Record<string,string>> {
  const parsed: unknown = JSON.parse(await readFile(path.join(root,"package.json"),"utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("package.json must contain a JSON object.");
  const scripts = (parsed as {scripts?:unknown}).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
  return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string,string] => typeof entry[1] === "string"));
}
export async function discoverChecks(inputPath: string): Promise<AvailableCheck[]> {
  const root = await verifiedProjectRoot(inputPath);
  const scripts = await packageScripts(root);
  return Object.entries(scripts)
    .filter(([name]) => SCRIPT_NAME.test(name) && !/^pre|^post/.test(name))
    .map(([name,command]) => ({name,command,packageManager:"npm" as const}))
    .sort((a,b)=>a.name.localeCompare(b.name));
}
export async function runVerification(
  inputPath: string,
  script: string,
  options: { timeoutMs?: number } = {},
): Promise<VerificationResult> {
  const root = await verifiedProjectRoot(inputPath);
  if (!SCRIPT_NAME.test(script) || /^pre|^post/.test(script)) throw new Error("Choose a valid, explicit package script name (pre/post lifecycle scripts are not selectable).");
  const scripts = await packageScripts(root);
  if (!(script in scripts)) throw new Error(`Script "${script}" is not defined in package.json.`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT) throw new Error("Timeout must be between 1,000 and 600,000 milliseconds.");
  const startedAt = new Date();
  const chunks: string[] = [];
  let outputSize = 0;
  let outputTruncated = false;
  const append = (chunk: Buffer | string) => {
    const value = chunk.toString();
    const remaining = MAX_OUTPUT - outputSize;
    if (remaining > 0) {
      const kept = value.slice(0,remaining);
      chunks.push(kept);
      outputSize += kept.length;
    }
    if (value.length > remaining) outputTruncated = true;
  };
  const windows = process.platform === "win32";
  // Do not forward provider/API credentials or arbitrary parent-process variables to project scripts.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    CI: "1",
    NODE_ENV: "test",
    FORGE_VERIFICATION: "1",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  };
  const child = spawn(windows ? "npm.cmd" : "npm", ["run-script","--ignore-scripts",script], {
    cwd:root, shell:windows, windowsHide:true, env, stdio:["ignore","pipe","pipe"], detached: !windows,
  });
  child.stdout.on("data",append);
  child.stderr.on("data",append);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (!windows && child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    } else child.kill("SIGTERM");
  }, timeoutMs);
  const outcome = await new Promise<{exitCode:number|null;signal:string|null;error?:string}>(resolve=>{
    child.once("error",error=>resolve({exitCode:null,signal:null,error:error.message}));
    child.once("close",(code,signal)=>resolve({exitCode:code,signal}));
  });
  clearTimeout(timer);
  if(outcome.error) append(`\nFORGE could not start npm: ${outcome.error}\n`);
  const finishedAt = new Date();
  return {
    id:`verify-${startedAt.getTime().toString(36)}-${Math.random().toString(36).slice(2,8)}`,
    projectPath:root, script, command:`npm run-script --ignore-scripts ${script}`,
    status:outcome.error?"spawn_error":timedOut?"timed_out":outcome.exitCode===0?"passed":"failed",
    exitCode:outcome.exitCode,signal:outcome.signal,durationMs:finishedAt.getTime()-startedAt.getTime(),
    startedAt:startedAt.toISOString(),finishedAt:finishedAt.toISOString(),output:chunks.join(""),outputTruncated,
  };
}
export function formatVerificationResult(result: VerificationResult): string {
  return [
    "# FORGE Verification Result","",
    `- **Script:** \`${result.script}\``,
    `- **Status:** \`${result.status.toUpperCase()}\``,
    `- **Exit code:** \`${result.exitCode===null?"not available":result.exitCode}\``,
    `- **Duration:** \`${result.durationMs} ms\``,
    `- **Started:** \`${result.startedAt}\``,"",
    "## Command output","",
    result.output || "(No output captured.)",
    result.outputTruncated?"\n[Output truncated at 64 KiB.]":"",
    "","_The selected package script was explicitly executed. Review its output; a passing exit code is not a security or correctness certification._"
  ].join("\n");
}

export interface DependencyInstallResult {
  status: "passed" | "failed" | "timed_out" | "spawn_error";
  exitCode: number | null;
  durationMs: number;
  output: string;
  outputTruncated: boolean;
  command: string;
}

/** Installs lockfile dependencies without lifecycle scripts. This operation can access the network. */
export async function installVerificationDependencies(
  inputPath: string,
  options: { timeoutMs?: number } = {},
): Promise<DependencyInstallResult> {
  const root = await verifiedProjectRoot(inputPath);
  const lockInfo = await lstat(path.join(root, "package-lock.json")).catch(() => null);
  if (!lockInfo || lockInfo.isSymbolicLink() || !lockInfo.isFile()) {
    throw new Error("Dependency preparation requires a regular package-lock.json; no installation was attempted.");
  }
  const timeoutMs = options.timeoutMs ?? MAX_TIMEOUT;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT) {
    throw new Error("Dependency installation timeout must be between 1,000 and 600,000 milliseconds.");
  }
  const startedAt = Date.now();
  const chunks: string[] = [];
  let outputSize = 0;
  let outputTruncated = false;
  const append = (chunk: Buffer | string) => {
    const value = chunk.toString();
    const remaining = MAX_OUTPUT - outputSize;
    if (remaining > 0) {
      const kept = value.slice(0, remaining);
      chunks.push(kept);
      outputSize += kept.length;
    }
    if (value.length > remaining) outputTruncated = true;
  };
  const windows = process.platform === "win32";
  const userConfig = path.join(root, ".forge-npm-user-config");
  const globalConfig = path.join(root, ".forge-npm-global-config");
  await Promise.all([
    writeFile(userConfig, "", { flag: "wx", mode: 0o600 }),
    writeFile(globalConfig, "", { flag: "wx", mode: 0o600 }),
  ]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "", CI: "1", NODE_ENV: "test", FORGE_VERIFICATION: "1",
    HOME: root, USERPROFILE: root,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
  };
  const command = "npm ci --ignore-scripts --no-audit --no-fund --userconfig <temporary-empty-config> --globalconfig <temporary-empty-config>";
  const child = spawn(windows ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--userconfig", userConfig, "--globalconfig", globalConfig], {
    cwd: root, shell: windows, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"], detached: !windows,
  });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let timedOut = false;
  const outcome = await new Promise<{ exitCode: number | null; error?: string }>(resolve => {
    let settled = false;
    const finish = (value: { exitCode: number | null; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (!windows && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else child.kill("SIGTERM");
    }, timeoutMs);
    child.once("error", error => finish({ exitCode: null, error: error.message }));
    child.once("close", code => finish({ exitCode: code }));
  });
  if (outcome.error) append("\\nFORGE could not start npm: " + outcome.error + "\\n");
  return {
    status: outcome.error ? "spawn_error" : timedOut ? "timed_out" : outcome.exitCode === 0 ? "passed" : "failed",
    exitCode: outcome.exitCode, durationMs: Date.now() - startedAt,
    output: chunks.join(""), outputTruncated, command,
  };
}
