import { readFile } from "node:fs/promises";
import path from "node:path";
import { mapArchitecture } from "./architecture-map.js";

export interface DependencyGraphNode {
  id: string; label: string; kind: "file" | "package";
  status: "entry" | "internal" | "declared" | "undeclared" | "possible-unused";
  detail: string; imports: string[];
}
export interface DependencyGraphEdge { from: string; to: string; kind: "internal" | "external"; }
export interface DependencyGraphReport {
  generatedAt: string; scannedFiles: number; nodes: DependencyGraphNode[];
  edges: DependencyGraphEdge[];
  summary: { files: number; packages: number; declared: number; undeclared: number; possibleUnused: number; relationships: number };
  warnings: string[];
}
function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier.slice(5);
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}
const BUILTINS = new Set(["assert","buffer","child_process","crypto","events","fs","http","https","module","os","path","process","stream","timers","url","util","zlib","worker_threads","perf_hooks","readline","dns","net","tls","tty","v8","vm","wasi","punycode","querystring","string_decoder","sys","inspector","async_hooks","console","constants","dgram","diagnostics_channel","trace_events"]);
export async function buildDependencyGraph(inputPath: string): Promise<DependencyGraphReport> {
  const root = path.resolve(inputPath);
  const architecture = await mapArchitecture(root);
  let manifest: Record<string, unknown> = {};
  const warnings = [...architecture.warnings];
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) manifest = parsed as Record<string, unknown>;
    else warnings.push("package.json does not contain a JSON object; package status is incomplete.");
  } catch { warnings.push("No readable package.json was found; package status is incomplete."); }
  const groups = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
  const declared = new Map<string, string>();
  for (const group of groups) {
    const values = manifest[group];
    if (values && typeof values === "object" && !Array.isArray(values)) {
      for (const [name, version] of Object.entries(values)) if (typeof version === "string") declared.set(name, group + " · " + version);
    }
  }
  const imported = new Map<string, Set<string>>();
  for (const node of architecture.nodes) for (const specifier of node.imports) {
    if (specifier.startsWith(".")) continue;
    const name = packageName(specifier);
    if (!name || BUILTINS.has(name)) continue;
    if (!imported.has(name)) imported.set(name, new Set());
    imported.get(name)!.add(node.file);
  }
  const selectedFiles = [...architecture.nodes].sort((a,b)=>b.imports.length-a.imports.length||a.file.localeCompare(b.file)).slice(0,80).sort((a,b)=>a.file.localeCompare(b.file));
  const selectedFileIds = new Set(selectedFiles.map(node => "f:" + node.file));
  const packageNames = new Set([...declared.keys(), ...imported.keys()]);
  const selectedPackages = [...packageNames].sort((a,b)=>a.localeCompare(b)).slice(0,60);
  const nodes: DependencyGraphNode[] = selectedFiles.map(node => ({
    id: "f:" + node.file, label: node.file.split("/").slice(-2).join("/"), kind: "file",
    status: node.role === "entry" ? "entry" : "internal",
    detail: node.file + " · " + node.role + " · " + node.lines + " lines", imports: node.imports
  }));
  for (const name of selectedPackages) {
    const files = [...(imported.get(name) ?? [])].sort(), isDeclared = declared.has(name);
    nodes.push({ id: "p:" + name, label: name, kind: "package",
      status: isDeclared ? (files.length ? "declared" : "possible-unused") : "undeclared",
      detail: (declared.get(name) ?? "Not declared in package.json") + " · imported by " + files.length + " file(s)", imports: files });
  }
  const edges: DependencyGraphEdge[] = [];
  for (const edge of architecture.edges) {
    const from = "f:" + edge.from, to = "f:" + edge.to;
    if (selectedFileIds.has(from) && selectedFileIds.has(to)) edges.push({ from, to, kind: "internal" });
  }
  for (const [name, files] of imported) {
    if (!selectedPackages.includes(name)) continue;
    for (const file of files) {
      const from = "f:" + file, to = "p:" + name;
      if (selectedFileIds.has(from)) edges.push({ from, to, kind: "external" });
    }
  }
  const declaredCount = [...declared.keys()].filter(name => imported.has(name)).length;
  const undeclared = [...imported.keys()].filter(name => !declared.has(name));
  const possibleUnused = [...declared.keys()].filter(name => !imported.has(name));
  if (architecture.nodes.length > selectedFiles.length) warnings.push("Graph view is limited to 80 source files, prioritizing modules with more imports.");
  if (packageNames.size > selectedPackages.length) warnings.push("Graph view is limited to 60 package nodes.");
  return { generatedAt: new Date().toISOString(), scannedFiles: architecture.scannedFiles, nodes,
    edges: edges.sort((a,b)=>a.from.localeCompare(b.from)||a.to.localeCompare(b.to)),
    summary: { files: selectedFiles.length, packages: selectedPackages.length, declared: declaredCount, undeclared: undeclared.length, possibleUnused: possibleUnused.length, relationships: edges.length }, warnings };
}
