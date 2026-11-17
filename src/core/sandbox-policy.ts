import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { SandboxSecurityProfileName } from "./sandbox-security-profiles.js";

export interface SandboxPolicy {
  version: 1;
  profile: SandboxSecurityProfileName;
  network: "none";
  readOnlyRoot: true;
  dropAllCapabilities: true;
  noNewPrivileges: true;
  maxMemory: string;
  maxCpus: number;
  maxProcesses: number;
  requireRootless: boolean;
  requireImageDigest: true;
}

const ALLOWED_PROFILES = ["balanced", "hardened", "rootless-required"];
const MEMORY = /^([1-9][0-9]{0,3})(m|g)$/;
const MAX_POLICY_BYTES = 16 * 1024;

export function validateSandboxPolicy(value: unknown): { valid: true; policy: SandboxPolicy } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Policy must be a JSON object."] };
  const input = value as Record<string, unknown>;
  const allowed = new Set(["version", "profile", "network", "readOnlyRoot", "dropAllCapabilities", "noNewPrivileges", "maxMemory", "maxCpus", "maxProcesses", "requireRootless", "requireImageDigest"]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) errors.push("Unknown policy field: " + key);
  if (input.version !== 1) errors.push("version must be 1.");
  if (typeof input.profile !== "string" || !ALLOWED_PROFILES.includes(input.profile)) errors.push("profile must be balanced, hardened, or rootless-required.");
  if (input.network !== "none") errors.push("network must remain none; network access cannot be enabled.");
  if (input.readOnlyRoot !== true) errors.push("readOnlyRoot must remain true.");
  if (input.dropAllCapabilities !== true) errors.push("dropAllCapabilities must remain true.");
  if (input.noNewPrivileges !== true) errors.push("noNewPrivileges must remain true.");
  if (typeof input.maxMemory !== "string" || !MEMORY.test(input.maxMemory)) errors.push("maxMemory must be a positive integer followed by m or g.");
  else { const m = input.maxMemory.match(MEMORY)!; const amount = Number(m[1]) * (m[2] === "g" ? 1024 : 1); if (amount > 1024) errors.push("maxMemory cannot exceed 1g."); }
  if (typeof input.maxCpus !== "number" || !Number.isFinite(input.maxCpus) || input.maxCpus <= 0 || input.maxCpus > 2) errors.push("maxCpus must be greater than 0 and at most 2.");
  if (typeof input.maxProcesses !== "number" || !Number.isInteger(input.maxProcesses) || input.maxProcesses < 1 || input.maxProcesses > 128) errors.push("maxProcesses must be an integer from 1 to 128.");
  if (typeof input.requireRootless !== "boolean") errors.push("requireRootless must be a boolean.");
  if (input.requireImageDigest !== true) errors.push("requireImageDigest must remain true.");
  if ((input.profile === "hardened" || input.profile === "rootless-required") && input.requireRootless !== true) errors.push("Selected profile requires rootless mode.");
  if (errors.length) return { valid: false, errors };
  return { valid: true, policy: input as unknown as SandboxPolicy };
}

export async function loadSandboxPolicy(filePath: string): Promise<{ valid: true; policy: SandboxPolicy; path: string } | { valid: false; errors: string[]; path: string }> {
  const resolved = path.resolve(filePath);
  try {
    const metadata = await lstat(resolved);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      return { valid: false, errors: ["Policy path must be a regular, non-symlink file."], path: resolved };
    }
    if (metadata.size > MAX_POLICY_BYTES) {
      return { valid: false, errors: ["Policy file exceeds the 16 KiB size limit."], path: resolved };
    }
    const raw = await readFile(resolved, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_POLICY_BYTES) {
      return { valid: false, errors: ["Policy file exceeds the 16 KiB size limit."], path: resolved };
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { valid: false, errors: ["Policy file is not valid JSON."], path: resolved }; }
    const result = validateSandboxPolicy(parsed);
    return result.valid ? { ...result, path: resolved } : { ...result, path: resolved };
  } catch (error) {
    return { valid: false, errors: [error instanceof Error ? error.message : String(error)], path: resolved };
  }
}

export function formatSandboxPolicyValidation(result: Awaited<ReturnType<typeof loadSandboxPolicy>>): string {
  return ["# FORGE Sandbox Policy Validation", "", "- File: " + result.path, "- Result: " + (result.valid ? "VALID" : "INVALID"), "", ...(result.valid ? ["Policy may be considered by the runtime enforcement layer; validation itself does not apply it."] : result.errors.map(error => "- " + error))].join("\n");
}
