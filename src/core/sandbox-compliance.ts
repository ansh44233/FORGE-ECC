import type { SandboxSecurityProfile } from "./sandbox-security-profiles.js";

export interface SandboxComplianceCheck {
  id: string;
  label: string;
  status: "pass" | "warning" | "fail";
  evidence: string;
}

export interface SandboxComplianceReport {
  profile: string;
  status: "compliant" | "partial" | "non-compliant";
  checks: SandboxComplianceCheck[];
  generatedAt: string;
}

export function createSandboxComplianceReport(
  profile: SandboxSecurityProfile,
  runtime: { available: boolean; rootless: boolean | null; imageDigestPinned: boolean },
): SandboxComplianceReport {
  const checks: SandboxComplianceCheck[] = [
    { id: "image-digest", label: "Immutable image reference", status: runtime.imageDigestPinned ? "pass" : "fail", evidence: runtime.imageDigestPinned ? "Image reference includes a SHA-256 digest." : "Image reference is not digest-pinned." },
    { id: "network", label: "Network isolation", status: "pass", evidence: "FORGE configures --network=none." },
    { id: "read-only-root", label: "Read-only container root", status: "pass", evidence: "FORGE configures --read-only." },
    { id: "capabilities", label: "Linux capabilities", status: "pass", evidence: "FORGE configures --cap-drop=ALL." },
    { id: "no-new-privileges", label: "Privilege escalation", status: "pass", evidence: "FORGE configures no-new-privileges." },
    { id: "resource-limits", label: "Resource limits", status: "pass", evidence: "FORGE configures memory, CPU and PID limits." },
    { id: "runtime", label: "Container runtime available", status: runtime.available ? "pass" : "fail", evidence: runtime.available ? "Container runtime probes succeeded." : "Container runtime availability was not confirmed." },
    { id: "rootless", label: "Rootless runtime", status: runtime.rootless === true ? "pass" : profile.requireRootless ? "fail" : runtime.rootless === false ? "warning" : "warning", evidence: runtime.rootless === true ? "Docker reports rootless mode." : runtime.rootless === false ? "Docker reports a rootful daemon." : "Rootless status is unknown." },
  ];
  const failed = checks.some(check => check.status === "fail");
  const warnings = checks.some(check => check.status === "warning");
  return {
    profile: profile.name,
    status: failed ? "non-compliant" : warnings ? "partial" : "compliant",
    checks,
    generatedAt: new Date().toISOString(),
  };
}

export function formatSandboxComplianceReport(report: SandboxComplianceReport): string {
  return [
    "# FORGE Sandbox Compliance",
    "",
    "- Profile: " + report.profile,
    "- Result: " + report.status.toUpperCase(),
    "- Generated: " + report.generatedAt,
    "",
    ...report.checks.map(check => "- [" + check.status.toUpperCase() + "] " + check.label + ": " + check.evidence),
    "",
    "This report describes FORGE-configured controls and observed runtime facts; it is not an independent security audit or guarantee.",
  ].join("\n");
}
