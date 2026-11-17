import path from "node:path";
import { mapArchitecture } from "./architecture-map.js";
import { auditProject, type FindingSeverity } from "./quality-audit.js";

export type EngineeringRiskLevel = "high" | "elevated" | "moderate" | "low";
export interface EngineeringRiskHotspot {
  file: string;
  score: number;
  level: EngineeringRiskLevel;
  fanIn: number;
  fanOut: number;
  centrality: number;
  lines: number;
  hasMatchingTest: boolean;
  signals: string[];
}
export interface EngineeringRiskReport {
  root: string;
  generatedAt: string;
  methodology: string;
  summary: { scannedFiles: number; relationships: number; hotspots: number; high: number; elevated: number; moderate: number; low: number; withoutMatchingTests: number; qualityFindings: number; severeQualityFindings: number };
  hotspots: EngineeringRiskHotspot[];
  qualitySignals: Array<{ severity: FindingSeverity; title: string; detail: string; recommendation: string }>;
  warnings: string[];
}
function levelFor(score: number): EngineeringRiskLevel {
  if (score >= 70) return "high";
  if (score >= 50) return "elevated";
  if (score >= 30) return "moderate";
  return "low";
}
function matchingTest(file: string, testFiles: string[]): boolean {
  const base = path.posix.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
  if (base.length < 3) return false;
  return testFiles.some(test => {
    const lower = test.toLowerCase();
    const testBase = path.posix.basename(lower).replace(/\.(test|spec)\.[^.]+$/, "").replace(/\.[^.]+$/, "");
    return testBase === base || lower.includes("/tests/" + base) || lower.includes("/__tests__/" + base);
  });
}
export async function analyzeEngineeringRisk(inputPath: string): Promise<EngineeringRiskReport> {
  const root = path.resolve(inputPath);
  const [architecture, quality] = await Promise.all([mapArchitecture(root), auditProject(root)]);
  const files = architecture.nodes.map(node => node.file);
  const testFiles = files.filter(file => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[^/]+$/i.test(file));
  const fanIn = new Map(files.map(file => [file, 0]));
  const fanOut = new Map(files.map(file => [file, 0]));
  const outgoing = new Map(files.map(file => [file, [] as string[]]));
  for (const edge of architecture.edges) {
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  // PageRank-like dependency centrality: importers transfer influence to the modules they depend on.
  const count = files.length;
  let rank = new Map(files.map(file => [file, count ? 1 / count : 0]));
  const damping = 0.85;
  for (let iteration = 0; iteration < 24 && count > 0; iteration++) {
    const next = new Map(files.map(file => [file, (1 - damping) / count]));
    let dangling = 0;
    for (const file of files) {
      const links = outgoing.get(file) ?? [];
      const value = rank.get(file) ?? 0;
      if (!links.length) dangling += value;
      else for (const target of links) next.set(target, (next.get(target) ?? 0) + damping * value / links.length);
    }
    const share = damping * dangling / count;
    for (const file of files) next.set(file, (next.get(file) ?? 0) + share);
    rank = next;
  }
  const maxIn = Math.max(1, ...fanIn.values());
  const maxOut = Math.max(1, ...fanOut.values());
  const maxRank = Math.max(Number.EPSILON, ...rank.values());
  const maxLines = Math.max(1, ...architecture.nodes.map(node => node.lines));
  const hotspots: EngineeringRiskHotspot[] = architecture.nodes.map(node => {
    const incoming = fanIn.get(node.file) ?? 0;
    const outgoingCount = fanOut.get(node.file) ?? 0;
    const centrality = rank.get(node.file) ?? 0;
    const hasTest = matchingTest(node.file, testFiles);
    const score = Math.round(
      30 * incoming / maxIn +
      20 * outgoingCount / maxOut +
      25 * centrality / maxRank +
      15 * Math.min(1, node.lines / maxLines) +
      (hasTest ? 0 : 10)
    );
    const signals: string[] = [];
    if (incoming >= 3) signals.push("High fan-in: multiple modules depend on this file.");
    if (outgoingCount >= 5) signals.push("High fan-out: this file depends on many internal modules.");
    if (centrality / maxRank >= 0.65) signals.push("High dependency centrality.");
    if (node.lines >= 300) signals.push("Large source file (300+ lines).");
    if (!hasTest && node.role !== "test" && node.role !== "config") signals.push("No matching test file detected by filename heuristic.");
    return { file: node.file, score, level: levelFor(score), fanIn: incoming, fanOut: outgoingCount,
      centrality: Number(centrality.toFixed(6)), lines: node.lines, hasMatchingTest: hasTest, signals };
  }).filter(item => item.level !== "low" || item.signals.length > 0)
    .sort((a,b) => b.score-a.score || a.file.localeCompare(b.file)).slice(0, 25);
  const severe = quality.findings.filter(item => item.severity === "critical" || item.severity === "high").length;
  const summary = {
    scannedFiles: architecture.scannedFiles, relationships: architecture.edges.length,
    hotspots: hotspots.length,
    high: hotspots.filter(item => item.level === "high").length,
    elevated: hotspots.filter(item => item.level === "elevated").length,
    moderate: hotspots.filter(item => item.level === "moderate").length,
    low: hotspots.filter(item => item.level === "low").length,
    withoutMatchingTests: architecture.nodes.filter(node => node.role !== "test" && node.role !== "config" && !matchingTest(node.file, testFiles)).length,
    qualityFindings: quality.findings.length, severeQualityFindings: severe
  };
  return {
    root, generatedAt: new Date().toISOString(),
    methodology: "Heuristic score: fan-in 30%, fan-out 20%, dependency centrality 25%, relative file size 15%, and missing filename-matched tests 10%.",
    summary, hotspots,
    qualitySignals: quality.findings.slice(0, 10).map(({ severity, title, detail, recommendation }) => ({ severity, title, detail, recommendation })),
    warnings: [...architecture.warnings, ...quality.limitations,
      "Risk scores prioritize structural review; they do not measure defect probability, security, runtime criticality, or actual test coverage.",
      "Filename-based test matching can miss shared, generated, integration, or differently named tests.",
      "Only the top 25 hotspots are returned; dependency centrality is computed from the static import graph."]
  };
}
export function formatEngineeringRisk(report: EngineeringRiskReport): string {
  const lines = [
    "# FORGE Engineering Risk Report", "",
    `- **Project:** \`${report.root}\``,
    `- **Source files:** ${report.summary.scannedFiles}`,
    `- **Internal relationships:** ${report.summary.relationships}`,
    `- **Hotspots:** ${report.summary.hotspots} (high ${report.summary.high}, elevated ${report.summary.elevated}, moderate ${report.summary.moderate})`,
    `- **Quality findings:** ${report.summary.qualityFindings} (${report.summary.severeQualityFindings} high/critical)`, "",
    "## Highest-priority modules",
    ...(report.hotspots.length ? report.hotspots.slice(0, 15).map(item => `### [${item.level.toUpperCase()} · ${item.score}/100] \`${item.file}\`
- Fan-in: ${item.fanIn}; fan-out: ${item.fanOut}; lines: ${item.lines}; matching test: ${item.hasMatchingTest ? "detected" : "not detected"}
- ${item.signals.join(" ")}`) : ["No structural hotspots detected by the available heuristics."]),
    "", "## Methodology", report.methodology, "",
    "## Limitations", ...report.warnings.map(item => `- ${item}`)
  ];
  return lines.join("\n");
}
