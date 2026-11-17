import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { isExcludedScanDirectory } from "./workspace-scan-policy.js";

const MAX_ENTRIES = 200;
const MAX_PREVIEW_BYTES = 128 * 1024;
const BLOCKED_NAME = /(^|[. _-])(env|secret|secrets|credential|credentials|private|token|password)([. _-]|$)/i;
const PREVIEW_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx", ".txt",
  ".html", ".css", ".scss", ".sass", ".less", ".yml", ".yaml", ".toml", ".xml",
  ".svg", ".sql", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".php", ".rb",
  ".sh", ".ps1", ".bat", ".c", ".h", ".cpp", ".hpp", ".swift", ".vue", ".svelte"
]);

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  size?: number;
  extension?: string;
}

export interface WorkspaceDirectory {
  path: string;
  parent: string | null;
  entries: WorkspaceEntry[];
  truncated: boolean;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolveWorkspacePath(rootPath: string, relativePath: string): Promise<{ root: string; target: string; relative: string }> {
  const root = await realpath(path.resolve(rootPath));
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.split("/").some(part => part === "..")) {
    throw new Error("Workspace path must stay inside the project.");
  }
  const segments = normalized.split("/").filter(part => part && part !== ".");
  assertWorkspacePathAllowed(segments.join("/"));
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    const segmentInfo = await lstat(cursor);
    if (segmentInfo.isSymbolicLink()) throw new Error("Symbolic links are not browsable.");
  }
  const target = path.resolve(root, ...segments);
  if (!isInside(root, target)) throw new Error("Workspace path must stay inside the project.");
  const info = await lstat(target);
  if (info.isSymbolicLink()) throw new Error("Symbolic links are not browsable.");
  const actual = await realpath(target);
  if (!isInside(root, actual)) throw new Error("Workspace path must stay inside the project.");
  return { root, target: actual, relative: segments.join("/") };
}

function isBlocked(name: string): boolean {
  return BLOCKED_NAME.test(name) || /\.(pem|key|p12|pfx|keystore)$/i.test(name);
}

export function assertWorkspacePathAllowed(relativePath: string): void {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some(isBlocked)) throw new Error("Sensitive workspace paths are not browsable.");
  if (segments.some(segment => segment.startsWith(".") || isExcludedScanDirectory(segment))) {
    throw new Error("Hidden or excluded workspace paths are not browsable.");
  }
}

export async function listWorkspaceDirectory(projectPath: string, relativePath = ""): Promise<WorkspaceDirectory> {
  const resolved = await resolveWorkspacePath(projectPath, relativePath);
  const info = await lstat(resolved.target);
  if (!info.isDirectory()) throw new Error("Workspace path is not a directory.");
  const dirents = await readdir(resolved.target, { withFileTypes: true });
  const entries: WorkspaceEntry[] = [];
  for (const dirent of dirents) {
    if (dirent.name.startsWith(".") || isBlocked(dirent.name)) continue;
    if (dirent.isSymbolicLink()) continue;
    const childPath = path.join(resolved.target, dirent.name);
    let childInfo;
    try { childInfo = await lstat(childPath); } catch { continue; }
    const relative = [resolved.relative, dirent.name].filter(Boolean).join("/");
    if (childInfo.isDirectory()) {
      if (!isExcludedScanDirectory(dirent.name)) entries.push({ name: dirent.name, path: relative, kind: "directory" });
    } else if (childInfo.isFile() && PREVIEW_EXTENSIONS.has(path.extname(dirent.name).toLowerCase())) {
      entries.push({ name: dirent.name, path: relative, kind: "file", size: childInfo.size, extension: path.extname(dirent.name).slice(1) });
    }
  }
  entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
  return {
    path: resolved.relative,
    parent: resolved.relative ? path.posix.dirname(resolved.relative) === "." ? "" : path.posix.dirname(resolved.relative) : null,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES
  };
}

export async function readWorkspaceFile(projectPath: string, relativePath: string): Promise<{ path: string; name: string; extension: string; size: number; content: string }> {
  const resolved = await resolveWorkspacePath(projectPath, relativePath);
  const name = path.basename(resolved.target);
  const extension = path.extname(name).toLowerCase();
  if (isBlocked(name) || !PREVIEW_EXTENSIONS.has(extension)) throw new Error("This file type is not available in the workspace preview.");
  // O_NOFOLLOW closes the final-component symlink swap between lstat and read.
  const handle = await open(resolved.target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Workspace item is not a regular file.");
    if (info.size > MAX_PREVIEW_BYTES) throw new Error("File is too large to preview (128 KiB maximum).");
    const content = await handle.readFile({ encoding: "utf8" });
    if (content.includes("\u0000")) throw new Error("Binary files cannot be previewed.");
    return { path: resolved.relative, name, extension: extension.slice(1), size: info.size, content };
  } finally {
    await handle.close();
  }
}
