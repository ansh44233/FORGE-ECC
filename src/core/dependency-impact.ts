import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";
import { mapArchitecture } from "./architecture-map.js";

const execFileAsync = promisify(execFile);
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
type DependencyGroup = "dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies";
export interface DependencyEntry { name: string; version: string; group: DependencyGroup; }
export interface DependencyChange { name: string; change: "added" | "removed" | "version-changed"; before?: string; after?: string; directConsumers: string[]; downstreamConsumers: string[]; }
export interface DependencyImpactReport {
  root: string; generatedAt: string; manifestFound: boolean; dependencies: DependencyEntry[];
  lockfile: { path: string | null; status: "consistent" | "mismatch" | "missing" | "unsupported"; mismatches: string[] };
  importedPackages: Array<{ name: string; files: string[] }>;
  undeclaredImports: Array<{ name: string; files: string[] }>;
  unusedCandidates: Array<{ name: string; group: DependencyGroup }>;
  changedFiles: Array<{ status: string; file: string; affected: string[] }>;
  dependencyChanges: DependencyChange[];
  risk: { level: "low" | "moderate" | "high"; reasons: string[] };
  warnings: string[];
}
type Manifest = Record<string, unknown>;
const GROUPS: DependencyGroup[] = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
function asRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier.slice(5);
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}
function parseManifest(value: unknown): Manifest | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Manifest : null;
}
async function readManifest(file: string): Promise<Manifest | null> {
  try { return parseManifest(JSON.parse(await readFile(file, "utf8"))); } catch { return null; }
}
async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout;
}
function dependencyMap(manifest: Manifest | null): Map<string, { version: string; group: DependencyGroup }> {
  const result = new Map<string, { version: string; group: DependencyGroup }>();
  if (!manifest) return result;
  for (const group of GROUPS) for (const [name, version] of Object.entries(asRecord(manifest[group]))) result.set(name, { version, group });
  return result;
}
function reverseImpact(changed: string[], edges: Array<{ from: string; to: string }>): Map<string, string[]> {
  const reverse = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    reverse.get(edge.to)!.add(edge.from);
  }
  const result = new Map<string, string[]>();
  for (const file of changed) {
    const seen = new Set<string>();
    const queue = [file];
    while (queue.length) {
      const current = queue.shift()!;
      for (const parent of reverse.get(current) ?? []) if (parent !== file && !seen.has(parent)) {
        seen.add(parent); queue.push(parent);
      }
    }
    result.set(file, [...seen].sort());
  }
  return result;
}
function consumersFor(name: string, nodes: Array<{ file: string; imports: string[] }>): string[] {
  return nodes.filter(node => node.imports.some(specifier => !specifier.startsWith(".") && packageName(specifier) === name)).map(node => node.file).sort();
}
export async function analyzeDependencyImpact(inputPath: string, base = "HEAD"): Promise<DependencyImpactReport> {
  const root = path.resolve(inputPath), warnings: string[] = [];
  const manifest = await readManifest(path.join(root, "package.json"));
  if (!manifest) warnings.push("No valid package.json was found; npm dependency analysis is unavailable.");
  const current = dependencyMap(manifest);
  const dependencies = [...current.entries()].map(([name, value]) => ({ name, ...value })).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
  const architecture = await mapArchitecture(root);
  warnings.push(...architecture.warnings);
  const importedMap = new Map<string, Set<string>>();
  for (const node of architecture.nodes) for (const specifier of node.imports) {
    if (specifier.startsWith(".")) continue;
    const name = packageName(specifier);
    if (BUILTINS.has(name)) continue;
    if (!importedMap.has(name)) importedMap.set(name, new Set());
    importedMap.get(name)!.add(node.file);
  }
  const importedPackages = [...importedMap.entries()].map(([name, files]) => ({ name, files: [...files].sort() })).sort((a, b) => a.name.localeCompare(b.name));
  const undeclaredImports = importedPackages.filter(item => !current.has(item.name));
  const unusedCandidates = dependencies.filter(item => !importedMap.has(item.name)).map(({ name, group }) => ({ name, group }));

  let lockfile: DependencyImpactReport["lockfile"] = { path: null, status: "missing", mismatches: [] };
  try {
    const lock = parseManifest(JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8")));
    const lockPackages = lock ? parseManifest(lock.packages) : null;
    const rootLock = lockPackages ? parseManifest(lockPackages[""]) : null;
    if (!rootLock) lockfile = { path: "package-lock.json", status: "unsupported", mismatches: ["Lockfile does not contain npm v2/v3 root package metadata."] };
    else {
      const mismatches: string[] = [];
      for (const group of GROUPS) {
        const declared = asRecord(manifest?.[group]), locked = asRecord(rootLock[group]);
        for (const [name, version] of Object.entries(declared)) if (locked[name] !== version) mismatches.push(group + ": " + name + " manifest=" + version + " lock=" + (locked[name] ?? "(missing)"));
        for (const name of Object.keys(locked)) if (!(name in declared)) mismatches.push(group + ": " + name + " is present in lock metadata but absent from package.json");
      }
      lockfile = { path: "package-lock.json", status: mismatches.length ? "mismatch" : "consistent", mismatches };
    }
  } catch {
    lockfile = { path: null, status: "missing", mismatches: [] };
  }
  if (lockfile.status === "missing") warnings.push("No readable npm package-lock.json was found; lockfile consistency could not be checked.");

  const changedFiles: DependencyImpactReport["changedFiles"] = [];
  let changedManifest: Manifest | null = null;
  try {
    const diff = await git(root, ["diff", "--name-status", "-M", base]);
    const changes = diff.split(/\r?\n/).filter(Boolean).map(line => {
      const [status, ...names] = line.split("\t");
      return { status: status ?? "?", file: names.at(-1) ?? "" };
    }).filter(item => item.file);
    const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])).split(/\r?\n/).filter(Boolean);
    const seen = new Set(changes.map(item => item.file));
    for (const file of untracked) if (!seen.has(file)) changes.push({ status: "?", file });
    const impact = reverseImpact(changes.filter(item => item.status !== "D").map(item => item.file), architecture.edges);
    for (const item of changes.sort((a, b) => a.file.localeCompare(b.file))) changedFiles.push({ ...item, affected: impact.get(item.file) ?? [] });
    if (changes.some(item => item.file === "package.json")) {
      try { changedManifest = parseManifest(JSON.parse(await git(root, ["show", base + ":package.json"]))); }
      catch { warnings.push("The base package.json could not be read; dependency additions/removals cannot be compared with the selected base."); }
    }
  } catch {
    warnings.push("Git change analysis is unavailable; run this command inside a Git repository with the selected base revision.");
  }
  const previous = dependencyMap(changedManifest), dependencyChanges: DependencyChange[] = [];
  for (const name of [...new Set([...current.keys(), ...previous.keys()])].sort()) {
    const before = previous.get(name), after = current.get(name);
    if (!before && after) dependencyChanges.push({ name, change: "added", after: after.version, directConsumers: consumersFor(name, architecture.nodes), downstreamConsumers: [] });
    else if (before && !after) dependencyChanges.push({ name, change: "removed", before: before.version, directConsumers: consumersFor(name, architecture.nodes), downstreamConsumers: [] });
    else if (before && after && (before.version !== after.version || before.group !== after.group)) dependencyChanges.push({ name, change: "version-changed", before: before.version, after: after.version, directConsumers: consumersFor(name, architecture.nodes), downstreamConsumers: [] });
  }
  const fileImpact = reverseImpact(dependencyChanges.flatMap(change => change.directConsumers), architecture.edges);
  for (const change of dependencyChanges) change.downstreamConsumers = [...new Set(change.directConsumers.flatMap(file => fileImpact.get(file) ?? []))].sort();
  const reasons: string[] = [];
  if (dependencyChanges.some(change => change.change === "removed" && change.directConsumers.length)) reasons.push("A removed dependency is still imported by source files.");
  if (dependencyChanges.some(change => change.change === "removed")) reasons.push("One or more dependencies were removed from the manifest.");
  if (dependencyChanges.some(change => change.change === "version-changed")) reasons.push("One or more dependency version specifications changed.");
  if (undeclaredImports.length) reasons.push(undeclaredImports.length + " imported package(s) are not declared in package.json.");
  if (lockfile.status === "mismatch") reasons.push("package.json and package-lock.json root dependency metadata differ.");
  const level = reasons.some(reason => reason.startsWith("A removed dependency")) ? "high" : reasons.length ? "moderate" : "low";
  return { root, generatedAt: new Date().toISOString(), manifestFound: Boolean(manifest), dependencies, lockfile, importedPackages, undeclaredImports, unusedCandidates, changedFiles, dependencyChanges, risk: { level, reasons }, warnings };
}
export function formatDependencyImpact(report: DependencyImpactReport): string {
  return [
    "# FORGE Dependency & Change Impact", "",
    "- Dependencies declared: " + report.dependencies.length,
    "- External packages imported: " + report.importedPackages.length,
    "- Undeclared imports: " + report.undeclaredImports.length,
    "- Possible unused declarations: " + report.unusedCandidates.length,
    "- Changed files: " + report.changedFiles.length,
    "- Dependency changes: " + report.dependencyChanges.length,
    "- Risk estimate: " + report.risk.level.toUpperCase(), "",
    "## Dependency changes",
    ...(report.dependencyChanges.length ? report.dependencyChanges.map(item => "- " + item.change + " `" + item.name + "`" + (item.before ? " (" + item.before + " → " + (item.after ?? "removed") + ")" : item.after ? " (" + item.after + ")" : "") + "; direct consumers: " + (item.directConsumers.join(", ") || "none detected") + "; downstream: " + (item.downstreamConsumers.join(", ") || "none detected")) : ["- No manifest dependency changes detected relative to the selected base."]),
    "", "## Lockfile consistency", "- " + (report.lockfile.path ?? "package-lock.json") + ": " + report.lockfile.status, ...report.lockfile.mismatches.map(item => "- " + item),
    "", "## Undeclared imports", ...(report.undeclaredImports.length ? report.undeclaredImports.map(item => "- `" + item.name + "` imported by " + item.files.join(", ")) : ["- No undeclared external imports detected."]),
    "", "## Possible unused declarations", ...(report.unusedCandidates.length ? report.unusedCandidates.map(item => "- `" + item.name + "` (" + item.group + ") is not referenced by scanned static imports.") : ["- No candidates detected."]),
    "", "## Changed-file blast radius", ...(report.changedFiles.length ? report.changedFiles.map(item => "- [" + item.status + "] `" + item.file + "` may affect: " + (item.affected.join(", ") || "no static importers detected")) : ["- No tracked or untracked changes detected relative to the selected base."]),
    "", "## Limitations",
    "- Import and blast-radius analysis is static and heuristic. Aliases, dynamic imports, runtime loading, generated code, configuration-only usage, and package scripts may be missed.",
    "- Unused dependency candidates are not removal recommendations; dependencies may be used by tools, scripts, plugins, or configuration.",
    "- Only npm package.json and package-lock.json metadata are checked. This is not a vulnerability or outdated-version scan.",
    ...(report.risk.reasons.length ? report.risk.reasons.map(reason => "- Risk: " + reason) : ["- No configured dependency risk signals detected."]),
    ...report.warnings.map(warning => "- Warning: " + warning)
  ].join("\n");
}
