import { describe, expect, it } from "vitest";
import { buildRemediationPlan } from "../src/core/remediation-planner.js";
import type { DependencyIntelligenceReport } from "../src/core/dependency-intelligence.js";

function fixture(): DependencyIntelligenceReport {
  return {
    root: "/fixture", generatedAt: "2026-01-01T00:00:00.000Z", ecosystem: "npm", manifestFound: true,
    lockfile: { name: "package-lock.json", parsed: true, lockedPackages: 2 },
    summary: { direct: 2, production: 2, development: 0, optional: 0, peer: 0, transitive: 0, vulnerablePackages: 1, vulnerabilities: 1, critical: 1, high: 0, moderate: 0, low: 0, outdated: 1, unknownLicenses: 1, copyleftLicenses: 0 },
    dependencies: [
      { name: "alpha", requested: "^1.0.0", locked: "1.0.0", direct: true, kind: "production", license: "MIT", licenseClass: "permissive", outdated: { current: "1.0.0", wanted: "1.2.0", latest: "2.0.0" }, vulnerabilities: [{ severity: "critical", title: "Example advisory", range: "<1.1.0", fixAvailable: true }] },
      { name: "beta", requested: "^2.0.0", locked: "2.0.0", direct: true, kind: "production", license: null, licenseClass: "unknown", outdated: null, vulnerabilities: [] }
    ],
    sources: { vulnerabilityReport: "npm-audit.json", outdatedReport: "npm-outdated.json" }, limitations: []
  };
}
describe("remediation planner", () => {
  it("prioritizes evidence-backed vulnerabilities before lower-risk updates", () => {
    const plan = buildRemediationPlan(fixture());
    expect(plan.items[0]?.priority).toBe("critical");
    expect(plan.items[0]?.command).toBe("npm audit fix --dry-run");
    expect(plan.summary.critical).toBe(1);
    expect(plan.summary.evidenceBacked).toBe(2);
    expect(plan.summary.advisory).toBe(1);
  });
  it("distinguishes compatible wanted updates from major-version review", () => {
    const plan = buildRemediationPlan(fixture());
    const update = plan.items.find(item => item.id === "outdated:alpha");
    expect(update?.suggestedVersion).toBe("1.2.0");
    expect(update?.command).toContain("alpha@1.2.0");
    expect(update?.recommendedAction).toContain("Review");
  });
  it("never executes commands and labels missing reports as unassessed", () => {
    const report = fixture();
    report.sources = { vulnerabilityReport: null, outdatedReport: null };
    report.dependencies = report.dependencies.map(item => ({ ...item, vulnerabilities: [], outdated: null }));
    const plan = buildRemediationPlan(report);
    expect(plan.items.some(item => item.category === "vulnerability")).toBe(false);
    expect(plan.evidence.vulnerabilityReport).toBeNull();
    expect(plan.limitations.join(" ")).toContain("never executed");
  });
});
