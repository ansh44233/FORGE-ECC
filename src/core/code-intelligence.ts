import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { mapArchitecture } from "./architecture-map.js";

export interface CodeSymbol {
  file: string;
  name: string;
  kind: "class" | "function" | "interface" | "type" | "enum" | "method";
  exported: boolean;
  line: number;
}
export interface DeepArchitectureReport {
  root: string;
  generatedAt: string;
  symbols: CodeSymbol[];
  circularDependencies: string[][];
  impact: Array<{ file: string; affected: string[] }>;
  warnings: string[];
}

function isExported(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword));
}

function symbolName(node: ts.NamedDeclaration): string | undefined {
  return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) ? node.name.text : undefined;
}

function declarations(source: ts.SourceFile, file: string): CodeSymbol[] {
  const found: CodeSymbol[] = [];
  const visit = (node: ts.Node): void => {
    let kind: CodeSymbol["kind"] | undefined;
    if (ts.isClassDeclaration(node)) kind = "class";
    else if (ts.isFunctionDeclaration(node)) kind = "function";
    else if (ts.isInterfaceDeclaration(node)) kind = "interface";
    else if (ts.isTypeAliasDeclaration(node)) kind = "type";
    else if (ts.isEnumDeclaration(node)) kind = "enum";
    else if (ts.isMethodDeclaration(node) && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) kind = "method";
    if (kind) {
      const name = symbolName(node as ts.NamedDeclaration);
      if (name) found.push({ file, name, kind, exported: isExported(node), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function findCycles(edges: Array<{from:string;to:string}>): string[][] {
  const graph = new Map<string,string[]>();
  for (const edge of edges) graph.set(edge.from,[...(graph.get(edge.from) ?? []),edge.to]);
  const cycles = new Map<string,string[]>();
  for (const start of graph.keys()) {
    const walk = (node:string, pathSoFar:string[], seen:Set<string>):void => {
      for (const next of graph.get(node) ?? []) {
        if (next === start && pathSoFar.length > 1) {
          const ring = [...pathSoFar].sort();
          cycles.set(ring.join("|"),ring);
        } else if (!seen.has(next) && pathSoFar.length < 40) {
          const copy = new Set(seen); copy.add(next); walk(next,[...pathSoFar,next],copy);
        }
      }
    };
    walk(start,[start],new Set([start]));
  }
  return [...cycles.values()];
}

export async function analyzeCodebase(inputPath:string):Promise<DeepArchitectureReport>{
  const root=path.resolve(inputPath);
  const architecture=await mapArchitecture(root);
  const symbols:CodeSymbol[]=[];
  const warnings=[...architecture.warnings];
  for(const node of architecture.nodes){
    try{
      const text=await readFile(path.join(root,node.file),"utf8");
      const source=ts.createSourceFile(node.file,text,ts.ScriptTarget.Latest,true,node.file.endsWith(".tsx")||node.file.endsWith(".jsx")?ts.ScriptKind.TSX:ts.ScriptKind.TS);
      symbols.push(...declarations(source,node.file));
    }catch{warnings.push("AST analysis skipped "+node.file+".");}
  }
  const internal=architecture.edges.filter(e=>e.kind==="internal").map(e=>({from:e.from,to:e.to}));
  const reverse=new Map<string,Set<string>>();
  for(const edge of internal){if(!reverse.has(edge.to))reverse.set(edge.to,new Set());reverse.get(edge.to)?.add(edge.from);}
  const impact=architecture.nodes.map(node=>{
    const affected=new Set<string>();const queue=[node.file];
    while(queue.length){const current=queue.shift()!;for(const parent of reverse.get(current)??[]){if(!affected.has(parent)&&parent!==node.file){affected.add(parent);queue.push(parent);}}}
    return {file:node.file,affected:[...affected].sort()};
  }).filter(item=>item.affected.length).sort((a,b)=>a.file.localeCompare(b.file));
  return {root,generatedAt:new Date().toISOString(),symbols:symbols.sort((a,b)=>a.file.localeCompare(b.file)||a.line-b.line),circularDependencies:findCycles(internal),impact,warnings};
}

export function formatCodebaseAnalysis(report:DeepArchitectureReport):string{
  const exported=report.symbols.filter(s=>s.exported);
  return [
    "# FORGE Deep Code Intelligence","",
    "- Project: `"+report.root+"`",
    "- AST symbols: "+report.symbols.length+" ("+exported.length+" exported)",
    "- Circular dependency groups: "+report.circularDependencies.length,
    "- Files with downstream impact: "+report.impact.length,"",
    "## Symbols",
    ...(report.symbols.length?report.symbols.map(s=>"- `"+s.file+":"+s.line+"` — "+s.kind+" "+s.name+(s.exported?" (exported)":"")):["- No named declarations detected."]),"",
    "## Circular dependencies",
    ...(report.circularDependencies.length?report.circularDependencies.map(c=>"- "+c.map(f=>"`"+f+"`").join(" → ")):["- None detected."]),"",
    "## Change impact",
    ...(report.impact.length?report.impact.map(i=>"- `"+i.file+"` may affect: "+i.affected.map(f=>"`"+f+"`").join(", ")):["- No reverse dependency paths detected."]),"",
    "## Limitations",
    "- AST symbol discovery uses the TypeScript parser; it does not perform type checking or resolve symbols across project boundaries.",
    "- Import edges still come from FORGE's static import resolver. Aliases, generated modules, and runtime-loaded dependencies may be missed.",
    "- Change impact is a transitive file-import estimate, not a guarantee that every listed file must change.",
    ...(report.warnings.length?report.warnings.map(w=>"- "+w):[])
  ].join("\n");
}
