export type SandboxSecurityProfileName = "balanced" | "hardened" | "rootless-required";

export interface SandboxSecurityProfile {
  name: SandboxSecurityProfileName;
  description: string;
  network: "none";
  readOnlyRoot: true;
  dropAllCapabilities: true;
  noNewPrivileges: true;
  maxMemory: "1g";
  maxCpus: 2;
  maxProcesses: 128;
  requireRootless: boolean;
}

const PROFILES: Record<SandboxSecurityProfileName, SandboxSecurityProfile> = {
  balanced: {
    name: "balanced",
    description: "Network-disabled container with read-only root and bounded resources.",
    network: "none", readOnlyRoot: true, dropAllCapabilities: true,
    noNewPrivileges: true, maxMemory: "1g", maxCpus: 2, maxProcesses: 128,
    requireRootless: false,
  },
  hardened: {
    name: "hardened",
    description: "Balanced controls with mandatory rootless Docker detection.",
    network: "none", readOnlyRoot: true, dropAllCapabilities: true,
    noNewPrivileges: true, maxMemory: "1g", maxCpus: 2, maxProcesses: 128,
    requireRootless: true,
  },
  "rootless-required": {
    name: "rootless-required",
    description: "Explicit rootless-only execution profile.",
    network: "none", readOnlyRoot: true, dropAllCapabilities: true,
    noNewPrivileges: true, maxMemory: "1g", maxCpus: 2, maxProcesses: 128,
    requireRootless: true,
  },
};

export function listSandboxSecurityProfiles(): SandboxSecurityProfile[] {
  return Object.values(PROFILES).map(profile => ({ ...profile }));
}

export function getSandboxSecurityProfile(name: string): SandboxSecurityProfile {
  if (!Object.prototype.hasOwnProperty.call(PROFILES, name)) {
    throw new Error("Unknown sandbox security profile: " + name);
  }
  return { ...PROFILES[name as SandboxSecurityProfileName] };
}

export function validateSandboxSecurityProfile(value: unknown): value is SandboxSecurityProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Record<string, unknown>;
  return ["balanced", "hardened", "rootless-required"].includes(String(profile.name)) &&
    profile.network === "none" && profile.readOnlyRoot === true &&
    profile.dropAllCapabilities === true && profile.noNewPrivileges === true &&
    profile.maxMemory === "1g" && profile.maxCpus === 2 &&
    profile.maxProcesses === 128 && typeof profile.requireRootless === "boolean";
}
