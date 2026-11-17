import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

export type VulnerabilitySeverity = "critical" | "high" | "moderate" | "low" | "info";
export interface DependencyRecord {
  name: string;
  requested: string;
  locked: string | null;
  direct: boolean;
  kind: "production" | "development" | "optional" | "peer" | "transitive";
  license: string | null;
  licenseClass: "permissive" | "copyleft" | "other" | "unknown";
  outdated: { current: string; wanted: string; latest: string } | null;
  vulnerabilities: Array<{ severity: VulnerabilitySeverity; title: string; range: string | null; fixAvailable: boolean | null }>;
}
export interface DependencyIntelligenceReport {
  root: string;
  generatedAt: string;
  ecosystem: "npm" | "unsupported" | "none";
  manifestFound: boolean;
  lockfile: { name: string | null; parsed: boolean; lockedPackages: number };
  summary: { direct: number; production: number; development: number; optional: number; peer: number; transitive: number; vulnerablePackages: number; vulnerabilities: number; critical: number; high: number; moderate: number; low: number; outdated: number; unknownLicenses: number; copyleftLicenses: number };
  dependencies: DependencyRecord[];
  sources: { vulnerabilityReport: string | null; outdatedReport: string | null };
  limitations: string[];
}
type JsonObject = Record<string, unknown>;
const SEVERITIES: VulnerabilitySeverity[] = ["critical","high","moderate","low","info"];
const NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function severity(value: unknown): VulnerabilitySeverity {
  const s = String(value ?? "").toLowerCase();
  return (SEVERITIES as string[]).includes(s) ? s as VulnerabilitySeverity : "info";
}
function classifyLicense(value: string | null): DependencyRecord["licenseClass"] {
  if (!value) return "unknown";
  const s = value.toUpperCase();
  if (/\b(AGPL|GPL|LGPL|SSPL|EUPL|OSL|CC-BY-SA|MPL)\b/.test(s)) return "copyleft";
  if (/\b(MIT|ISC|APACHE-2\.0|BSD-2-CLAUSE|BSD-3-CLAUSE|0BSD|UNLICENSE)\b/.test(s)) return "permissive";
  return "other";
}
function safeName(name: string): boolean { return NAME.test(name) && !name.split("/").some(part => part === "." || part === ".."); }
function packageNameFromLockPath(key: string): string | null {
  const match = key.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
  if (!match) return null;
  const name = match[1]!;
  return safeName(name) ? name : null;
}
async function readJson(file: string): Promise<JsonObject | null> {
  try { return object(JSON.parse(await readFile(file, "utf8"))); } catch { return null; }
}
async function readInside(root: string, file: string | undefined): Promise<{ value: JsonObject | null; label: string | null }> {
  if (!file) return { value: null, label: null };
  const resolved = path.resolve(root, file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Report paths must point to a file inside the project directory.");
  const value = await readJson(resolved);
  if (!value) throw new Error("Could not parse JSON report: " + relative);
  return { value, label: relative };
}
async function installedLicense(root: string, name: string): Promise<string | null> {
  if (!safeName(name)) return null;
  const base = path.join(root, "node_modules");
  const target = path.join(base, ...name.split("/"), "package.json");
  try {
    let cursor = base;
    for (const part of [...name.split("/"), "package.json"]) {
      cursor = path.join(cursor, part);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) return null;
    }
    const pkg = await readJson(target);
    const raw = pkg?.license;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return raw.map(item => text(object(item).type) ?? text(item)).filter(Boolean).join(" OR ") || null;
    if (raw && typeof raw === "object") return text(object(raw).type);
    return null;
  } catch { return null; }
}
function npmLockPackages(lock: JsonObject | null): Map<string, { version: string | null; license: string | null }> {
  const found = new Map<string, { version: string | null; license: string | null }>();
  const packages = object(lock?.packages);
  for (const [key, raw] of Object.entries(packages)) {
    const name = packageNameFromLockPath(key);
    if (!name) continue;
    const entry = object(raw);
    found.set(name, { version: text(entry.version), license: text(entry.license) });
  }
  if (!found.size && lock?.dependencies && typeof lock.dependencies === "object") {
    const walk = (entries: unknown) => {
      for (const [name, raw] of Object.entries(object(entries))) {
        if (!safeName(name)) continue;
        const entry = object(raw);
        found.set(name, { version: text(entry.version), license: text(entry.license) });
        walk(entry.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return found;
}
function npmAuditEntries(report: JsonObject | null): Map<string, DependencyRecord["vulnerabilities"]> {
  const result = new Map<string, DependencyRecord["vulnerabilities"]>();
  if (!report) return result;
  const vulnerabilities = object(report.vulnerabilities);
  for (const [name, raw] of Object.entries(vulnerabilities)) {
    if (!safeName(name)) continue;
    const item = object(raw);
    const entries = Array.isArray(item.via) ? item.via.filter(v => v && typeof v === "object").map(v => {
      const issue = object(v);
      return { severity: severity(issue.severity), title: text(issue.title) ?? "Reported vulnerability", range: text(issue.range), fixAvailable: typeof item.fixAvailable === "boolean" ? item.fixAvailable : null };
    }) : [];
    if (!entries.length && text(item.severity)) entries.push({ severity: severity(item.severity), title: "npm audit finding", range: text(item.range), fixAvailable: typeof item.fixAvailable === "boolean" ? item.fixAvailable : null });
    result.set(name, entries);
  }
  // npm v6 audit reports use the advisories object instead.
  for (const raw of Object.values(object(report.advisories))) {
    const item = object(raw);
    const name = text(item.module_name);
    if (!name || !safeName(name)) continue;
    const entries = result.get(name) ?? [];
    entries.push({ severity: severity(item.severity), title: text(item.title) ?? "npm audit advisory", range: text(item.vulnerable_versions), fixAvailable: null });
    result.set(name, entries);
  }
  return result;
}
function npmOutdatedEntries(report: JsonObject | null): Map<string, { current: string; wanted: string; latest: string }> {
  const result = new Map<string, { current: string; wanted: string; latest: string }>();
  for (const [name, raw] of Object.entries(object(report))) {
    if (!safeName(name)) continue;
    const item = object(raw);
    const current = text(item.current), wanted = text(item.wanted), latest = text(item.latest);
    if (current && latest && current !== latest) result.set(name, { current, wanted: wanted ?? current, latest });
  }
  return result;
}
export async function analyzeDependencies(inputPath: string, options: { auditReport?: string; outdatedReport?: string } = {}): Promise<DependencyIntelligenceReport> {
  const root = path.resolve(inputPath);
  const manifest = await readJson(path.join(root, "package.json"));
  const sections: Array<{ key: string; kind: DependencyRecord["kind"] }> = [
    { key: "dependencies", kind: "production" }, { key: "devDependencies", kind: "development" },
    { key: "optionalDependencies", kind: "optional" }, { key: "peerDependencies", kind: "peer" }
  ];
  const declared = new Map<string, { requested: string; kind: DependencyRecord["kind"] }>();
  for (const section of sections) for (const [name, requested] of Object.entries(object(manifest?.[section.key]))) {
    if (safeName(name) && typeof requested === "string") declared.set(name, { requested, kind: section.kind });
  }
  const lockCandidates = ["package-lock.json", "npm-shrinkwrap.json"];
  let lockName: string | null = null, lock: JsonObject | null = null;
  for (const candidate of lockCandidates) { lock = await readJson(path.join(root, candidate)); if (lock) { lockName = candidate; break; } }
  const lockPackages = npmLockPackages(lock);
  const auditPath = options.auditReport ?? (await exists(path.join(root, "npm-audit.json")) ? "npm-audit.json" : undefined);
  const outdatedPath = options.outdatedReport ?? (await exists(path.join(root, "npm-outdated.json")) ? "npm-outdated.json" : undefined);
  const [audit, outdated] = await Promise.all([
    readInside(root, auditPath),
    readInside(root, outdatedPath)
  ]);
  const vulnerabilityMap = npmAuditEntries(audit.value);
  const outdatedMap = npmOutdatedEntries(outdated.value);
  const names = new Set([...declared.keys(), ...lockPackages.keys(), ...vulnerabilityMap.keys(), ...outdatedMap.keys()]);
  const dependencies: DependencyRecord[] = [];
  for (const name of names) {
    const direct = declared.get(name);
    const locked = lockPackages.get(name);
    const license = locked?.license ?? await installedLicense(root, name);
    dependencies.push({
      name, requested: direct?.requested ?? "transitive",
      locked: locked?.version ?? null, direct: Boolean(direct), kind: direct?.kind ?? "transitive",
      license, licenseClass: classifyLicense(license), outdated: outdatedMap.get(name) ?? null,
      vulnerabilities: vulnerabilityMap.get(name) ?? []
    });
  }
  dependencies.sort((a,b) => Number(b.vulnerabilities.length>0)-Number(a.vulnerabilities.length>0) || Number(b.direct)-Number(a.direct) || a.name.localeCompare(b.name));
  const counts = { critical:0, high:0, moderate:0, low:0 };
  for (const item of dependencies) for (const vulnerability of item.vulnerabilities) if (vulnerability.severity in counts) counts[vulnerability.severity as keyof typeof counts]++;
  const lockedCount = lockPackages.size;
  const summary = {
    direct: declared.size,
    production: [...declared.values()].filter(x=>x.kind==="production").length,
    development: [...declared.values()].filter(x=>x.kind==="development").length,
    optional: [...declared.values()].filter(x=>x.kind==="optional").length,
    peer: [...declared.values()].filter(x=>x.kind==="peer").length,
    transitive: [...lockPackages.keys()].filter(name=>!declared.has(name)).length,
    vulnerablePackages: dependencies.filter(x=>x.vulnerabilities.length).length,
    vulnerabilities: Object.values(counts).reduce((a,b)=>a+b,0),
    ...counts,
    outdated: outdatedMap.size,
    unknownLicenses: dependencies.filter(x=>x.licenseClass==="unknown").length,
    copyleftLicenses: dependencies.filter(x=>x.licenseClass==="copyleft").length
  };
  const limitations = [
    audit.value ? "Vulnerability findings are imported from the supplied npm audit JSON report; FORGE does not run npm audit or contact a registry." : "Vulnerability status is NOT ASSESSED: provide an npm audit JSON report with --audit-report; no network scan is performed.",
    outdated.value ? "Outdated versions are imported from the supplied npm outdated JSON report; FORGE does not contact a package registry." : "Outdated status is NOT ASSESSED: provide npm outdated JSON with --outdated-report; no registry lookup is performed.",
    "Abandoned-package and maintainer-activity detection is not available in this offline report.",
    "License data comes from lockfile metadata or installed package manifests; missing license metadata is reported as unknown, not assumed permissive.",
    "This initial analyzer supports npm package.json and package-lock.json/npm-shrinkwrap.json. Other ecosystems and pnpm/yarn lockfile parsing are not yet supported.",
    "License classification is a coarse identifier heuristic, not legal advice or a compatibility determination."
  ];
  return { root, generatedAt: new Date().toISOString(), ecosystem: manifest ? "npm" : lock ? "npm" : names.size ? "unsupported" : "none",
    manifestFound: Boolean(manifest), lockfile: { name: lockName, parsed: Boolean(lock), lockedPackages: lockedCount },
    summary, dependencies, sources: { vulnerabilityReport: audit.label, outdatedReport: outdated.label }, limitations };
}
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch { return false; } }
export function formatDependencyIntelligence(report: DependencyIntelligenceReport): string {
  const s = report.summary;
  const lines = ["# FORGE Dependency Intelligence","", "- Project: `"+report.root+"`", "- Generated: "+report.generatedAt,
    "- Ecosystem: "+report.ecosystem, "- Manifest: "+(report.manifestFound?"package.json detected":"not detected"),
    "- Lockfile: "+(report.lockfile.name ? report.lockfile.name+" ("+report.lockfile.lockedPackages+" packages)" : "not parsed"), "",
    "## Inventory", "- Direct dependencies: "+s.direct+" (production "+s.production+", development "+s.development+", optional "+s.optional+", peer "+s.peer+")",
    "- Transitive locked packages: "+s.transitive, "- Outdated packages: "+(report.sources.outdatedReport===null?"NOT ASSESSED":s.outdated),
    "- Vulnerabilities: "+(report.sources.vulnerabilityReport===null?"NOT ASSESSED":s.vulnerabilities+" across "+s.vulnerablePackages+" packages"),
    "- Severity: critical "+s.critical+", high "+s.high+", moderate "+s.moderate+", low "+s.low,
    "- License metadata: "+s.unknownLicenses+" unknown, "+s.copyleftLicenses+" copyleft-classified", "",
    "## Dependency details", ...(report.dependencies.length ? report.dependencies.slice(0,100).map(item =>
      "- "+(item.direct?"direct":"transitive")+" `"+item.name+"`: "+(item.locked??item.requested)+" | license "+(item.license??"unknown")+" | "+item.licenseClass+
      (item.outdated?" | latest "+item.outdated.latest:"")+(item.vulnerabilities.length?" | "+item.vulnerabilities.length+" vulnerability finding(s)":"")
    ) : ["- No npm dependencies found."]), "",
    "## Limitations", ...report.limitations.map(item=>"- "+item), "",
    "_FORGE does not execute package-manager commands, install packages, modify manifests, or contact registries during this analysis._"];
  return lines.join("\n");
}
