import path from "node:path";
import { analyzeEngineeringRisk } from "./engineering-risk.js";
import { analyzeGitChanges, type GitIntelligenceReport } from "./git-intelligence.js";
import { mapArchitecture } from "./architecture-map.js";

export type ChangeRiskLevel = "high" | "elevated" | "moderate" | "low";
export interface ChangeRiskItem {
  file: string;
  status: string;
  score: number;
  level: ChangeRiskLevel;
  structuralScore: number;
  downstreamCount: number;
  affectedModules: string[];
  reasons: string[];
  recommendedTests: Array<{ file: string; reason: string; exists: boolean }>;
}
export interface ChangeIntelligenceReport {
  root: string;
  generatedAt: string;
  branch: string;
  base: string;
  summary: { changedFiles: number; high: number; elevated: number; moderate: number; low: number; affectedModules: number; testCandidates: number };
  overallRisk: { score: number; level: ChangeRiskLevel; reasons: string[] };
  changes: ChangeRiskItem[];
  warnings: string[];
}
function levelFor(score: number): ChangeRiskLevel {
  if (score >= 75) return "high";
  if (score >= 55) return "elevated";
  if (score >= 30) return "moderate";
  return "low";
}
function testBase(file: string): string {
  return path.posix.basename(file).replace(/\.[^.]+$/, "").toLowerCase();
}
function isTestFile(file: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$/i.test(file);
}
export async function analyzeChangeIntelligence(inputPath: string, base = "HEAD"): Promise<ChangeIntelligenceReport> {
  const root = path.resolve(inputPath);
  const [gitResult, structural, architecture] = await Promise.all([
    analyzeGitChanges(root, base).catch((error): GitIntelligenceReport => ({
      root, generatedAt: new Date().toISOString(), branch: "(Git unavailable)", base,
      changes: [], impact: [], suggestedTests: [],
      risk: { level: "low", reasons: [] },
      warnings: ["Git change analysis is unavailable: " + (error instanceof Error ? error.message : String(error))]
    })),
    analyzeEngineeringRisk(root), mapArchitecture(root)
  ]);
  const git = gitResult;
  const testFiles = architecture.nodes.map(node => node.file).filter(isTestFile);
  const riskByFile = new Map(structural.hotspots.map(item => [item.file, item]));
  const impactByFile = new Map(git.impact.map(item => [item.file, item.affected]));
  const changes = git.changes.map(change => {
    const affectedModules = impactByFile.get(change.file) ?? [];
    const candidates = [change.file, ...affectedModules];
    const existingTests = testFiles.filter(test => {
      const baseName = testBase(test).replace(/\.(test|spec)$/, "");
      return candidates.some(file => {
        const changedBase = testBase(file);
        return baseName === changedBase || baseName.startsWith(changedBase + ".") || changedBase.startsWith(baseName + ".");
      });
    });
    const suggested = git.suggestedTests.find(item => item.file.startsWith("tests/" + testBase(change.file) + "."));
    const hotspot = riskByFile.get(change.file);
    const affectedHotspots = affectedModules.map(file => riskByFile.get(file)).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const structuralScore = Math.max(hotspot?.score ?? 0, ...affectedHotspots.map(item => item.score), 0);
    const downstreamCount = affectedModules.length;
    const impactScore = Math.min(25, downstreamCount * 5);
    const score = Math.min(100, Math.round(structuralScore * 0.65 + impactScore + (git.risk.level === "high" ? 15 : git.risk.level === "moderate" ? 8 : 0)));
    const reasons: string[] = [];
    if (hotspot) reasons.push("Changed module has a structural hotspot score of " + hotspot.score + "/100.");
    if (downstreamCount) reasons.push(downstreamCount + " downstream module(s) may consume this change.");
    if (affectedHotspots.length) reasons.push("At least one affected module is a structural hotspot.");
    if (git.risk.reasons.length) reasons.push(...git.risk.reasons);
    if (!existingTests.length) reasons.push("No filename-matched existing test was found; review the suggested test path or identify integration tests.");
    const recommendedTests = existingTests.slice(0, 8).map(file => ({ file, reason: "Existing test candidate matching the changed module or an affected consumer.", exists: true }));
    if (!recommendedTests.length && suggested) recommendedTests.push({ file: suggested.file, reason: suggested.reason + " Confirm the appropriate test location before creating anything.", exists: false });
    return {
      file: change.file, status: change.status, score, level: levelFor(score), structuralScore,
      downstreamCount, affectedModules: affectedModules.slice(0, 20), reasons,
      recommendedTests
    };
  }).sort((a,b) => b.score-a.score || a.file.localeCompare(b.file));
  const score = changes.length ? Math.max(...changes.map(item => item.score)) : 0;
  const overallReasons = [...new Set([...git.risk.reasons, ...changes.flatMap(item => item.reasons).slice(0, 8)])];
  return {
    root, generatedAt: new Date().toISOString(), branch: git.branch, base,
    summary: {
      changedFiles: changes.length,
      high: changes.filter(item => item.level === "high").length,
      elevated: changes.filter(item => item.level === "elevated").length,
      moderate: changes.filter(item => item.level === "moderate").length,
      low: changes.filter(item => item.level === "low").length,
      affectedModules: new Set(changes.flatMap(item => item.affectedModules)).size,
      testCandidates: new Set(changes.flatMap(item => item.recommendedTests.map(test => test.file))).size
    },
    overallRisk: { score, level: levelFor(score), reasons: overallReasons },
    changes,
    warnings: [
      ...git.warnings, ...structural.warnings,
      "Change-risk scores combine static structural hotspots, downstream import counts, and Git path heuristics. They are prioritization signals, not predictions of defects or proof of causation.",
      "Impact and test matching use static source paths; aliases, generated code, dynamic imports, shared integration tests, and runtime behavior may be missed.",
      "Test recommendations are candidates only. FORGE does not create, modify, or execute tests in this analysis."
    ]
  };
}
export function formatChangeIntelligence(report: ChangeIntelligenceReport): string {
  return [
    "# FORGE Change Risk & Test Intelligence", "",
    "- Branch: " + report.branch,
    "- Compared with: " + report.base,
    "- Changed files: " + report.summary.changedFiles,
    "- Overall change risk: " + report.overallRisk.level.toUpperCase() + " (" + report.overallRisk.score + "/100)",
    "- Downstream modules: " + report.summary.affectedModules,
    "- Test candidates: " + report.summary.testCandidates, "",
    "## Prioritized changes",
    ...(report.changes.length ? report.changes.map(item =>
      "### [" + item.level.toUpperCase() + " · " + item.score + "/100] `" + item.file + "`\n" +
      "- Status: " + item.status + "; structural score: " + item.structuralScore + "; downstream modules: " + item.downstreamCount + "\n" +
      "- Reasons: " + (item.reasons.join(" ") || "No additional risk signals.") + "\n" +
      "- Test candidates: " + (item.recommendedTests.map(test => "`" + test.file + "`" + (test.exists ? "" : " (suggested, not found)")).join(", ") || "None identified")
    ) : ["No working-tree changes detected against the selected base."]),
    "", "## Overall risk signals",
    ...(report.overallRisk.reasons.length ? report.overallRisk.reasons.map(reason => "- " + reason) : ["- No configured risk patterns detected."]),
    "", "## Limitations", ...report.warnings.map(warning => "- " + warning)
  ].join("\n");
}
