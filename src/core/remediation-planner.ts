import { analyzeDependencies, type DependencyIntelligenceReport, type DependencyRecord } from "./dependency-intelligence.js";

export type RemediationPriority = "critical" | "high" | "moderate" | "low" | "info";
export interface RemediationItem {
  id: string;
  priority: RemediationPriority;
  category: "vulnerability" | "outdated" | "license" | "inventory";
  packageName: string;
  currentVersion: string | null;
  suggestedVersion: string | null;
  title: string;
  rationale: string;
  recommendedAction: string;
  command: string | null;
  confidence: "evidence-backed" | "advisory";
  requiresReview: true;
}
export interface RemediationPlan {
  root: string;
  generatedAt: string;
  evidence: { vulnerabilityReport: string | null; outdatedReport: string | null; lockfileParsed: boolean };
  summary: { total: number; critical: number; high: number; moderate: number; low: number; info: number; evidenceBacked: number; advisory: number };
  items: RemediationItem[];
  limitations: string[];
}

function priorityFor(severity: string): RemediationPriority {
  return severity === "critical" || severity === "high" || severity === "moderate" || severity === "low" ? severity : "info";
}
function versionParts(value: string): number[] | null {
  const match = value.trim().replace(/^[~^=v]/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}
function updateGuidance(item: DependencyRecord): { title: string; rationale: string; action: string; command: string | null } {
  const outdated = item.outdated!;
  const current = versionParts(outdated.current), wanted = versionParts(outdated.wanted), latest = versionParts(outdated.latest);
  const isMajor = Boolean(current && latest && latest[0] !== current[0]);
  if (wanted && current && wanted[0] !== undefined && wanted[1] !== undefined && wanted[2] !== undefined && current[0] !== undefined && current[1] !== undefined && current[2] !== undefined && wanted[0] === current[0] && (wanted[1] > current[1] || wanted[2] > current[2])) {
    return {
      title: "Review a compatible update",
      rationale: `npm outdated reports ${outdated.current} installed and ${outdated.wanted} wanted within the declared range; latest is ${outdated.latest}.`,
      action: "Review the package changelog and test compatibility, then update the lockfile using the wanted version if appropriate.",
      command: `npm install ${item.name}@${outdated.wanted}`
    };
  }
  return {
    title: isMajor ? "Assess a major-version upgrade" : "Review the reported version gap",
    rationale: `npm outdated reports current ${outdated.current}, wanted ${outdated.wanted}, latest ${outdated.latest}. FORGE cannot establish compatibility from version numbers alone.`,
    action: "Review release notes, migration guidance, peer dependencies and downstream usage before choosing an upgrade.",
    command: null
  };
}
export function buildRemediationPlan(report: DependencyIntelligenceReport): RemediationPlan {
  const items: RemediationItem[] = [];
  for (const dependency of report.dependencies) {
    for (const [index, vulnerability] of dependency.vulnerabilities.entries()) {
      const priority = priorityFor(vulnerability.severity);
      items.push({
        id: `vulnerability:${dependency.name}:${index}`, priority, category: "vulnerability",
        packageName: dependency.name, currentVersion: dependency.locked, suggestedVersion: null,
        title: vulnerability.title, rationale: `${vulnerability.severity} severity finding imported from ${report.sources.vulnerabilityReport ?? "an audit report"}; affected range: ${vulnerability.range ?? "not supplied"}.`,
        recommendedAction: vulnerability.fixAvailable === true
          ? "Inspect the npm audit remediation details and review the proposed dependency tree before applying any update."
          : vulnerability.fixAvailable === false
            ? "No automatic fix is reported. Review the advisory, assess exposure, and plan a compatible manual upgrade or mitigation."
            : "Review the advisory and determine whether a compatible fix is available; the imported report does not confirm fix availability.",
        command: vulnerability.fixAvailable === true ? "npm audit fix --dry-run" : null,
        confidence: "evidence-backed", requiresReview: true
      });
    }
    if (dependency.outdated) {
      const guidance = updateGuidance(dependency);
      items.push({
        id: `outdated:${dependency.name}`, priority: "low", category: "outdated",
        packageName: dependency.name, currentVersion: dependency.outdated.current,
        suggestedVersion: dependency.outdated.wanted, title: guidance.title, rationale: guidance.rationale,
        recommendedAction: guidance.action, command: guidance.command,
        confidence: "evidence-backed", requiresReview: true
      });
    }
    if (dependency.licenseClass === "unknown") {
      items.push({
        id: `license:${dependency.name}`, priority: "info", category: "license",
        packageName: dependency.name, currentVersion: dependency.locked, suggestedVersion: null,
        title: "Verify license metadata",
        rationale: "No license identifier was available in the lockfile or installed package manifest.",
        recommendedAction: "Inspect the package's authoritative LICENSE file and published metadata; do not assume permission from missing metadata.",
        command: null, confidence: "advisory", requiresReview: true
      });
    } else if (dependency.licenseClass === "copyleft") {
      items.push({
        id: `license:${dependency.name}`, priority: "moderate", category: "license",
        packageName: dependency.name, currentVersion: dependency.locked, suggestedVersion: null,
        title: "Review copyleft license obligations",
        rationale: `License metadata is ${dependency.license ?? "classified as copyleft"}; classification is heuristic and is not a legal conclusion.`,
        recommendedAction: "Have the project's responsible reviewer assess the exact license text and distribution obligations.",
        command: null, confidence: "advisory", requiresReview: true
      });
    }
  }
  if (!report.manifestFound) {
    items.push({
      id: "inventory:missing-manifest", priority: "info", category: "inventory", packageName: "(project)",
      currentVersion: null, suggestedVersion: null, title: "No npm manifest detected",
      rationale: "The analyzer did not find a readable package.json.",
      recommendedAction: "Confirm the project ecosystem before selecting a package-management remediation workflow.",
      command: null, confidence: "advisory", requiresReview: true
    });
  }
  const rank: Record<RemediationPriority, number> = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
  items.sort((a,b) => rank[a.priority]-rank[b.priority] || a.packageName.localeCompare(b.packageName) || a.id.localeCompare(b.id));
  const count = (priority: RemediationPriority) => items.filter(item => item.priority === priority).length;
  return {
    root: report.root, generatedAt: new Date().toISOString(),
    evidence: { vulnerabilityReport: report.sources.vulnerabilityReport, outdatedReport: report.sources.outdatedReport, lockfileParsed: report.lockfile.parsed },
    summary: { total: items.length, critical: count("critical"), high: count("high"), moderate: count("moderate"), low: count("low"), info: count("info"), evidenceBacked: items.filter(item=>item.confidence==="evidence-backed").length, advisory: items.filter(item=>item.confidence==="advisory").length },
    items,
    limitations: [
      "This is a reviewable plan, not an automated repair. FORGE does not install, upgrade, remove, or modify dependencies.",
      "Vulnerability and outdated recommendations are only as current as the imported local npm reports; no registry or advisory service is queried.",
      "Version compatibility cannot be inferred from semver alone. Review release notes, peer dependencies, lockfile changes, and project tests.",
      "License categories are heuristic metadata signals, not legal advice or a full SPDX compatibility analysis.",
      "Commands are suggestions only and are never executed by FORGE."
    ]
  };
}
export async function generateRemediationPlan(root: string, options: { auditReport?: string; outdatedReport?: string } = {}): Promise<RemediationPlan> {
  return buildRemediationPlan(await analyzeDependencies(root, options));
}
export function formatRemediationPlan(plan: RemediationPlan): string {
  const lines = [
    "# FORGE Remediation Plan", "", `- Project: \`${plan.root}\``, `- Generated: ${plan.generatedAt}`,
    `- Items: ${plan.summary.total} (critical ${plan.summary.critical}, high ${plan.summary.high}, moderate ${plan.summary.moderate}, low ${plan.summary.low}, info ${plan.summary.info})`,
    `- Evidence-backed: ${plan.summary.evidenceBacked}; advisory: ${plan.summary.advisory}`, "",
    "## Prioritized actions",
    ...(plan.items.length ? plan.items.map((item,index) => [
      `${index+1}. [${item.priority.toUpperCase()}] ${item.title} — ${item.packageName}`,
      `   ${item.rationale}`, `   Action: ${item.recommendedAction}`,
      ...(item.command ? [`   Suggested command (not executed): \`${item.command}\``] : [])
    ].join("\n")) : ["No remediation items were generated from the available evidence."]),
    "", "## Evidence", `- npm audit report: ${plan.evidence.vulnerabilityReport ?? "NOT PROVIDED — vulnerabilities not assessed"}`,
    `- npm outdated report: ${plan.evidence.outdatedReport ?? "NOT PROVIDED — outdated status not assessed"}`,
    `- Lockfile parsed: ${plan.evidence.lockfileParsed ? "yes" : "no"}`, "",
    "## Limitations", ...plan.limitations.map(item=>"- "+item), ""
  ];
  return lines.join("\n");
}
