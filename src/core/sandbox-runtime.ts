export interface SandboxRuntimeReport {
  runtime: string;
  available: boolean;
  version: string | null;
  rootless: boolean | null;
  securityOptions: string[];
  warnings: string[];
}

export function parseSandboxRuntimeReport(
  runtime: string,
  versionOutput: string,
  securityOptionsOutput: string,
): SandboxRuntimeReport {
  let options: unknown;
  const warnings: string[] = [];
  try { options = JSON.parse(securityOptionsOutput); } catch { options = null; }
  const securityOptions = Array.isArray(options) && options.every(value => typeof value === "string")
    ? options as string[] : [];
  const rootless = securityOptions.some(value => /(?:^|[, ])name=rootless(?:$|[, ])/i.test(value))
    ? true : securityOptions.length ? false : null;
  if (rootless === false) warnings.push("Docker daemon does not advertise rootless mode.");
  if (rootless === null) warnings.push("Rootless status could not be determined.");
  if (!versionOutput.trim()) warnings.push("Runtime version output was empty.");
  return {
    runtime,
    available: Boolean(versionOutput.trim()),
    version: versionOutput.trim() || null,
    rootless,
    securityOptions,
    warnings,
  };
}

export function formatSandboxRuntimeReport(report: SandboxRuntimeReport): string {
  return [
    "# FORGE Sandbox Runtime Status",
    "",
    "- Runtime: " + report.runtime,
    "- Available: " + (report.available ? "yes" : "no"),
    "- Version: " + (report.version ?? "unknown"),
    "- Rootless: " + (report.rootless === true ? "yes" : report.rootless === false ? "no" : "unknown"),
    "- Security options: " + (report.securityOptions.join(", ") || "unavailable"),
    "",
    ...(report.warnings.length ? ["## Warnings", ...report.warnings.map(value => "- " + value)] : ["No runtime warnings reported."]),
    "",
    "This is a capability/status probe, not a security certification.",
  ].join("\\n");
}
