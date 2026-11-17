import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isExcludedScanDirectory } from "./workspace-scan-policy.js";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g
];

export interface ArchitectureNode {
  file: string;
  imports: string[];
  lines: number;
  role: "entry" | "module" | "test" | "config" | "documentation";
}

export interface ArchitectureEdge {
  from: string;
  to: string;
  kind: "internal" | "external";
}

export interface ArchitectureMap {
  root: string;
  generatedAt: string;
  scannedFiles: number;
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
  entryPoints: string[];
  externalPackages: Array<{ name: string; importedBy: number }>;
  warnings: string[];
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function roleFor(file: string): ArchitectureNode["role"] {
  if (/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(file)) return "test";
  if (/\.(md|mdx|txt)$/.test(file)) return "documentation";
  if (/(^|\/)(config|configs)\//.test(file) || /(^|\/)(vite|next|vitest|eslint|prettier|tsconfig)\./.test(file)) return "config";
  if (/(^|\/)(index|main|cli|server|app)\.[jt]sx?$/.test(file) || /^(src\/)?(index|main|cli|server)\.[jt]sx?$/.test(file)) return "entry";
  return "module";
}

function resolveInternal(from: string, specifier: string, knownFiles: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [
    base, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(ext => base + ext),
    ...["index.ts", "index.tsx", "index.js", "index.jsx"].map(name => path.posix.join(base, name))
  ];
  return candidates.find(candidate => knownFiles.has(candidate)) ?? null;
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

export async function mapArchitecture(inputPath: string): Promise<ArchitectureMap> {
  const root = path.resolve(inputPath);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const sourceFiles = entries
    .filter(entry => entry.isFile())
    .map(entry => {
      const parentPath = (entry as { parentPath?: string }).parentPath ?? root;
      return path.relative(root, path.join(parentPath, entry.name)).split(path.sep).join("/");
    });
  const eligibleSourceFiles = sourceFiles.filter(file =>
    SOURCE_EXTENSIONS.has(path.extname(file)) &&
    !file.split("/").some(part => part.startsWith(".") || isExcludedScanDirectory(part))
  );
  const filtered = eligibleSourceFiles.slice(0, 3000);
  const knownFiles = new Set(filtered);
  const nodes: ArchitectureNode[] = [];
  const edges: ArchitectureEdge[] = [];
  const external = new Map<string, Set<string>>();
  const warnings: string[] = [];

  for (const file of filtered) {
    let content: string;
    try {
      content = await readFile(path.join(root, file), "utf8");
    } catch {
      warnings.push(`Could not read ${file}; it was skipped.`);
      continue;
    }
    const imports = unique(IMPORT_PATTERNS.flatMap(pattern => {
      pattern.lastIndex = 0;
      return [...content.matchAll(pattern)].map(match => match[1]).filter((value): value is string => Boolean(value));
    }));
    nodes.push({ file, imports, lines: content.split(/\r?\n/).length, role: roleFor(file) });

    for (const specifier of imports) {
      const internal = resolveInternal(file, specifier, knownFiles);
      if (internal) {
        edges.push({ from: file, to: internal, kind: "internal" });
      } else if (!specifier.startsWith(".")) {
        const name = packageName(specifier);
        if (!external.has(name)) external.set(name, new Set());
        external.get(name)?.add(file);
      }
    }
  }

  if (eligibleSourceFiles.length > filtered.length) warnings.push("Architecture scan was limited to 3,000 source files.");
  const importedInternally = new Set(edges.map(edge => edge.to));
  const entryPoints = nodes
    .filter(node => node.role === "entry" || !importedInternally.has(node.file))
    .map(node => node.file)
    .sort();

  return {
    root,
    generatedAt: new Date().toISOString(),
    scannedFiles: nodes.length,
    nodes: nodes.sort((a, b) => a.file.localeCompare(b.file)),
    edges: edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    entryPoints,
    externalPackages: [...external.entries()]
      .map(([name, files]) => ({ name, importedBy: files.size }))
      .sort((a, b) => b.importedBy - a.importedBy || a.name.localeCompare(b.name)),
    warnings
  };
}

export function formatArchitectureMap(map: ArchitectureMap): string {
  const lines = [
    "# FORGE Architecture Map", "",
    `- **Project:** \`${map.root}\``,
    `- **Source files mapped:** ${map.scannedFiles}`,
    `- **Internal import relationships:** ${map.edges.length}`,
    `- **Generated:** ${map.generatedAt}`, "",
    "## Entry points", ...(map.entryPoints.length ? map.entryPoints.map(file => `- \`${file}\``) : ["- None confidently identified."]), "",
    "## Module graph",
    ...(map.edges.length ? map.edges.map(edge => `- \`${edge.from}\` → \`${edge.to}\``) : ["- No relative import links detected."]), "",
    "## External packages",
    ...(map.externalPackages.length ? map.externalPackages.map(item => `- \`${item.name}\` (imported by ${item.importedBy} file(s))`) : ["- None detected."]), "",
    "## Files", ...map.nodes.map(node => `- \`${node.file}\` — ${node.role}, ${node.lines} lines, ${node.imports.length} imports`), "",
    "## Limitations",
    "- This is a static, heuristic import map, not a complete compiler-level dependency graph.",
    "- Dynamic imports assembled from variables, path aliases, and generated modules may not resolve.",
    ...(map.warnings.length ? map.warnings.map(warning => `- ${warning}`) : ["- No scan warnings."])
  ];
  return lines.join("\n");
}
