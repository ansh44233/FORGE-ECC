const EXCLUDED_SCAN_DIRECTORIES = new Set([
  ".git", ".forge", ".ssh", ".aws", ".azure", ".kube", ".docker", ".gnupg",
  ".npm", ".config", ".next", ".nuxt", ".output", ".turbo", ".vercel",
  ".venv", "venv", "__pycache__", ".idea", ".vscode",
  "node_modules", "dist", "build", "out", "coverage", "vendor"
]);

/** Shared directory policy for read-only project scanners. */
export function isExcludedScanDirectory(name: string): boolean {
  return EXCLUDED_SCAN_DIRECTORIES.has(name);
}
