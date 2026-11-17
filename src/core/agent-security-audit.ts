import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export type AgentSecuritySeverity = "critical" | "high" | "medium";

export interface AgentSecurityFinding {
  id: string;
  severity: AgentSecuritySeverity;
  file: string;
  line: number;
  title: string;
  detail: string;
  recommendation: string;
}

export interface AgentSecurityReport {
  status: "clean" | "findings" | "no-configs";
  generatedAt: string;
  filesScanned: number;
  findings: AgentSecurityFinding[];
  summary: { critical: number; high: number; medium: number };
  caveats: string[];
}

interface Rule {
  id: string;
  severity: AgentSecuritySeverity;
  title: string;
  pattern: RegExp;
  detail: string;
  recommendation: string;
}

const MAX_FILES = 200;
const MAX_ENTRIES = 5_000;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_DEPTH = 6;

const RULES: Rule[] = [
  {
    id: "FORGE-AGENT-001",
    severity: "critical",
    title: "Credential value embedded in agent configuration",
    pattern: /\b(?:api[_-]?key|access[_-]?token|secret|password|client[_-]?secret)\b\s*[:=]\s*["']?(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{30,})/i,
    detail: "A value resembling a live credential is present. FORGE redacts the matching line from this report.",
    recommendation: "Remove the credential from the file, rotate it with its provider, and use an environment-backed secret store.",
  },
  {
    id: "FORGE-AGENT-002",
    severity: "high",
    title: "Arbitrary command execution is explicitly permitted",
    pattern: /\b(?:run|execute|invoke|allow)\s+(?:any|arbitrary|unrestricted)\s+(?:shell\s+)?(?:command|commands|script|scripts|terminal)\b/i,
    detail: "The instruction appears to grant broad command execution without a task-specific boundary.",
    recommendation: "Replace broad command permission with a short allowlist and require human approval for actions that change project state.",
  },
  {
    id: "FORGE-AGENT-003",
    severity: "high",
    title: "Destructive actions can bypass review",
    pattern: /\b(?:without|skip|bypass|disable|no)\s+(?:human\s+)?(?:approval|confirmation|review)\b.{0,100}\b(?:delete|remove|overwrite|write|modify|deploy|publish|execute|run)\b|\b(?:delete|remove|overwrite|deploy|publish)\b.{0,100}\b(?:without|skip|bypass|no)\s+(?:human\s+)?(?:approval|confirmation|review)\b/i,
    detail: "A destructive or externally visible action is described as not requiring a review step.",
    recommendation: "Require explicit human approval before deletion, overwrites, deployments, publication, or other irreversible actions.",
  },
  {
    id: "FORGE-AGENT-004",
    severity: "high",
    title: "Untrusted repository or tool content is treated as instructions",
    pattern: /\b(?:follow|obey|execute|run|trust)\b.{0,80}\b(?:all\s+)?(?:instructions|commands|directives)\b.{0,80}\b(?:repository|repo\s+files?|tool\s+output|web\s+pages?|external\s+content)\b/i,
    detail: "The wording may allow untrusted project files or tool output to override the agent's trusted instructions.",
    recommendation: "Treat repository files, tool output, and external content as data. Never let them override system, developer, or user instructions.",
  },
  {
    id: "FORGE-AGENT-005",
    severity: "medium",
    title: "Unrestricted filesystem access is described",
    pattern: /\b(?:unrestricted|unlimited|full)\s+(?:read\s+and\s+write\s+)?(?:access|permissions?)\s+to\s+(?:the\s+)?(?:entire\s+)?(?:filesystem|file\s+system|all\s+files)\b/i,
    detail: "The configuration appears to grant broad filesystem access rather than limiting work to the project workspace.",
    recommendation: "Scope file access to the current workspace, block secrets and private key material, and keep writes behind an approval boundary.",
  },
  {
    id: "FORGE-AGENT-006",
    severity: "medium",
    title: "Unrestricted network access is described",
    pattern: /\b(?:unrestricted|unlimited|any|all)\s+(?:outbound\s+)?(?:internet|network)\s+access\b|\ballow\s+all\s+(?:outbound\s+)?network\s+traffic\b/i,
    detail: "The configuration appears to permit unrestricted network access for an agent or tool.",
    recommendation: "Use deny-by-default network access and explicitly allow only the endpoints required for the task.",
  },
];

const ROOT_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".mcp.json",
  "mcp.json",
]);
const SCANNED_DIRECTORIES = [
  ".forge/skills",
  ".forge/hooks",
  ".claude/commands",
  ".cursor/rules",
];
const SCANNED_FILES = new Set([
  ".forge/permissions.json",
  ".forge/policy.json",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".cursor/mcp.json",
  ".vscode/mcp.json",
  ".github/copilot-instructions.md",
]);

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function collectFiles(root: string, directory: string, depth: number, output: string[], visited: { count: number }): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    visited.count += 1;
    if (visited.count > MAX_ENTRIES) throw new Error(`Agent security scan exceeded the ${MAX_ENTRIES} directory-entry limit.`);
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const candidate = path.join(directory, entry.name);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) {
      await collectFiles(root, candidate, depth + 1, output, visited);
      continue;
    }
    if (!info.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (![".md", ".mdc", ".json", ".yaml", ".yml", ".toml"].includes(extension) && entry.name !== ".cursorrules") continue;
    if (info.size > MAX_FILE_BYTES) throw new Error(`Agent configuration exceeds the ${MAX_FILE_BYTES}-byte scan limit: ${path.relative(root, candidate)}`);
    const actual = await realpath(candidate);
    if (!isInside(root, actual)) continue;
    if (output.length >= MAX_FILES) throw new Error(`Agent security scan exceeded the ${MAX_FILES}-file limit.`);
    output.push(actual);
  }
}

async function readText(filePath: string): Promise<string> {
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("Agent configuration is not a regular file or exceeds the scan limit.");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new Error("Agent configuration exceeds the scan limit.");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function scanText(relativePath: string, content: string): AgentSecurityFinding[] {
  const findings: AgentSecurityFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(line)) continue;
      findings.push({
        id: rule.id,
        severity: rule.severity,
        file: relativePath,
        line: index + 1,
        title: rule.title,
        detail: rule.detail,
        recommendation: rule.recommendation,
      });
    }
  }
  return findings;
}

/**
 * Read-only, rule-based review of common AI-agent instruction and tool-policy files.
 * Reports locations and remediation guidance only; it never includes matched source text.
 */
export async function auditAgentConfiguration(projectPath: string): Promise<AgentSecurityReport> {
  const root = await realpath(path.resolve(projectPath));
  const files = new Set<string>();
  for (const name of ROOT_FILES) {
    const candidate = path.join(root, name);
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_FILE_BYTES) files.add(await realpath(candidate));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  for (const relative of SCANNED_FILES) {
    const candidate = path.join(root, relative);
    try {
      const info = await lstat(candidate);
      if (info.isFile() && !info.isSymbolicLink() && info.size <= MAX_FILE_BYTES) files.add(await realpath(candidate));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  const visited = { count: 0 };
  for (const relative of SCANNED_DIRECTORIES) {
    const found: string[] = [];
    await collectFiles(root, path.join(root, relative), 0, found, visited);
    for (const file of found) files.add(file);
  }

  const sortedFiles = [...files].filter(file => isInside(root, file)).sort();
  if (sortedFiles.length > MAX_FILES) throw new Error(`Agent security scan exceeded the ${MAX_FILES}-file limit.`);
  const findings: AgentSecurityFinding[] = [];
  for (const file of sortedFiles) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    findings.push(...scanText(relative, await readText(file)));
  }
  findings.sort((a, b) => ({ critical: 0, high: 1, medium: 2 }[a.severity] - ({ critical: 0, high: 1, medium: 2 }[b.severity]) || a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
  const summary = {
    critical: findings.filter(item => item.severity === "critical").length,
    high: findings.filter(item => item.severity === "high").length,
    medium: findings.filter(item => item.severity === "medium").length,
  };
  return {
    status: sortedFiles.length === 0 ? "no-configs" : findings.length ? "findings" : "clean",
    generatedAt: new Date().toISOString(),
    filesScanned: sortedFiles.length,
    findings,
    summary,
    caveats: [
      "This is a static, rule-based review of discovered configuration files, not a proof of agent safety.",
      "Only known file locations and high-signal patterns are checked; custom formats and runtime behavior may not be covered.",
      "Matched source lines and credential values are never included in the report.",
      "The scan is read-only and does not edit configurations or change permissions.",
    ],
  };
}

export function formatAgentSecurityReport(report: AgentSecurityReport): string {
  const lines = [
    "FORGE Agent Configuration Security Audit",
    "Status: " + report.status.toUpperCase(),
    "Files scanned: " + report.filesScanned,
    "Findings: " + report.summary.critical + " critical · " + report.summary.high + " high · " + report.summary.medium + " medium",
    "",
  ];
  if (!report.findings.length) lines.push(report.status === "no-configs" ? "No supported agent configuration files were found." : "No findings matched the current static rules.");
  for (const finding of report.findings) {
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.id} · ${finding.title}`);
    lines.push(`  ${finding.file}:${finding.line}`);
    lines.push("  " + finding.detail);
    lines.push("  RECOMMEND: " + finding.recommendation);
  }
  lines.push("", "Caveats:", ...report.caveats.map(item => "  - " + item));
  return lines.join("\n");
}
