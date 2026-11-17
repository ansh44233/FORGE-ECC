import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export interface ForgePermissionPolicy {
  version: 1;
  mode: "proposal-only" | "restricted";
  allowedTools: string[];
}

export const DEFAULT_PERMISSION_POLICY: ForgePermissionPolicy = {
  version: 1,
  mode: "proposal-only",
  allowedTools: [],
};

export function validatePermissionPolicy(value: unknown): ForgePermissionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Permission policy must be a JSON object.");
  }
  const item = value as Record<string, unknown>;
  if (item.version !== 1) throw new Error("Permission policy version must be 1.");
  if (item.mode !== "proposal-only" && item.mode !== "restricted") {
    throw new Error("Permission policy mode must be proposal-only or restricted.");
  }
  if (!Array.isArray(item.allowedTools) || item.allowedTools.length > 32 ||
      item.allowedTools.some(tool => typeof tool !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(tool))) {
    throw new Error("Permission policy allowedTools must be an array of at most 32 valid tool IDs.");
  }
  const keys = Object.keys(item);
  if (keys.some(key => !["version", "mode", "allowedTools"].includes(key))) {
    throw new Error("Permission policy contains unsupported fields.");
  }
  return { version: 1, mode: item.mode, allowedTools: [...new Set(item.allowedTools as string[])] };
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/** Loads declarative policy. Missing files resolve to the safe proposal-only default. */
export async function loadPermissionPolicy(projectPath: string): Promise<ForgePermissionPolicy> {
  const root = await realpath(path.resolve(projectPath));
  const directory = path.join(root, ".forge");
  const file = path.join(directory, "permissions.json");
  try {
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error("The .forge policy directory must be a real directory inside the project.");
    }
    // Bound policy parsing and reject a final-component symlink swap at open time.
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ELOOP") {
        throw new Error("The .forge/permissions.json policy file must be a regular file, not a symbolic link.");
      }
      throw error;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error("The .forge/permissions.json policy file must be a regular file, not a symbolic link.");
      }
      if (info.size > 16 * 1024) {
        throw new Error("The .forge/permissions.json policy file exceeds the 16 KiB limit.");
      }
      const actualFile = await realpath(file);
      const relative = path.relative(root, actualFile);
      if (relative.startsWith(".." + path.sep) || relative === ".." || path.isAbsolute(relative)) {
        throw new Error("The permission policy file must stay inside the project.");
      }
      return validatePermissionPolicy(JSON.parse(await handle.readFile({ encoding: "utf8" })));
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return { ...DEFAULT_PERMISSION_POLICY, allowedTools: [] };
    throw error;
  }
}

/** Fail closed until a concrete, audited tool executor is registered. */
export function assertProposalOnlyPolicy(policy: ForgePermissionPolicy, context = "FORGE run"): void {
  if (policy.mode !== "proposal-only" || policy.allowedTools.length !== 0) {
    throw new Error(`${context} cannot execute with the configured permission policy. This FORGE build supports proposal-only agents and has no registered tool executor; set mode to "proposal-only" and allowedTools to [].`);
  }
}


/** Allows only the audited read-only workspace tools for native OpenAI tool calling. */
export function assertSupportedAgentPolicy(policy: ForgePermissionPolicy, provider: string, context = "FORGE run"): void {
  if (policy.mode === "proposal-only" && policy.allowedTools.length === 0) return;
  const supported = new Set(["list-files", "read-file", "search-code"]);
  if (policy.mode !== "restricted" || provider !== "openai" || policy.allowedTools.length === 0 ||
      policy.allowedTools.some(tool => !supported.has(tool))) {
    throw new Error(`${context} cannot execute with this permission policy. Restricted tool execution currently supports only OpenAI with the audited read-only tools: list-files, read-file, search-code.`);
  }
}
