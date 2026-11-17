export interface ManagedContainer {
  id: string;
  status: string;
  name: string;
}

export function parseManagedContainers(output: string): ManagedContainer[] {
  const result: ManagedContainer[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [id, status, name, ...extra] = line.split("\t");
    if (extra.length || !id || !/^[a-f0-9]{12,64}$/i.test(id) || !status?.trim() || !name?.trim()) {
      throw new Error("Container runtime returned an invalid managed-container record.");
    }
    result.push({ id, status: status.trim(), name: name.trim() });
  }
  return result;
}

export function selectStoppedManagedContainers(containers: ManagedContainer[]): ManagedContainer[] {
  return containers.filter(container => /^(exited|created|dead)(?:\s|$)/i.test(container.status));
}

export function formatSandboxCleanupReport(
  candidates: ManagedContainer[],
  removed: string[] = [],
  apply = false,
): string {
  const lines = [
    "# FORGE Sandbox Cleanup",
    "",
    "- Mode: " + (apply ? "APPLY" : "DRY RUN"),
    "- Stopped managed containers found: " + candidates.length,
    "- Removed: " + removed.length,
    "",
  ];
  if (!candidates.length) lines.push("No stopped FORGE-managed containers found.");
  else {
    lines.push("## Candidates");
    for (const item of candidates) lines.push("- " + item.id + " — " + item.name + " (" + item.status + ")" + (removed.includes(item.id) ? " — removed" : ""));
  }
  lines.push("", "Only containers returned by the FORGE management label filter and in a stopped state are eligible. Active containers are never selected.");
  return lines.join("\n");
}
