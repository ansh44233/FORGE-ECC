import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isExcludedScanDirectory } from "./workspace-scan-policy.js";

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export interface QualityFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  evidence: string[];
  recommendation: string;
}
export interface QualityAudit {
  root: string;
  generatedAt: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
  coverage: { checksPerformed: number; checksAvailable: number };
  metrics: { manifests: number; sourceFiles: number; testFiles: number; workflowFiles: number };
  findings: QualityFinding[];
  limitations: string[];
}
const IGNORED = { has: isExcludedScanDirectory };
const SOURCE = new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".py",".go",".rs",".java",".cs",".rb",".php"]);
async function collect(root: string, rel = "", files: string[] = []): Promise<string[]> {
  if (files.length >= 5000) return files;
  let entries;
  try { entries = await readdir(path.join(root, rel), { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    if (files.length >= 5000) break;
    const child = path.posix.join(rel.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory() && !IGNORED.has(entry.name)) await collect(root, path.join(rel, entry.name), files);
    else if (entry.isFile()) files.push(child);
  }
  return files;
}
const has = (files: Set<string>, names: string[]) => names.some(name => files.has(name));
export async function auditProject(inputPath: string): Promise<QualityAudit> {
  const root = path.resolve(inputPath);
  const paths = await collect(root);
  const files = new Set(paths);
  const findings: QualityFinding[] = [];
  const add = (finding: QualityFinding) => findings.push(finding);
  const manifests = ["package.json","pyproject.toml","Cargo.toml","go.mod","pom.xml","build.gradle"].filter(name => files.has(name));
  const sourceFiles = paths.filter(file => SOURCE.has(path.extname(file).toLowerCase()));
  const testFiles = paths.filter(file => /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[^/]+$/i.test(file));
  const workflowFiles = paths.filter(file => file.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(file));
  const packageJson = await readJson(path.join(root,"package.json"));
  const scripts = (packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {}) as Record<string, unknown>;
  const tsconfig = await readJson(path.join(root,"tsconfig.json"));
  const tsStrict = tsconfig?.compilerOptions && typeof tsconfig.compilerOptions === "object"
    ? (tsconfig.compilerOptions as Record<string, unknown>).strict === true : false;

  if (!has(files,["README.md","readme.md"])) add({id:"docs.readme",severity:"medium",title:"README is missing",detail:"No root README was detected.",evidence:["README.md not found"],recommendation:"Add setup instructions, project purpose, usage examples, and known limitations."});
  if (!has(files,["LICENSE","LICENSE.md","LICENSE.txt"])) add({id:"legal.license",severity:"low",title:"License file is missing",detail:"No common root license file was detected.",evidence:["LICENSE variants not found"],recommendation:"Choose and include a license that matches the project's distribution goals."});
  if (!has(files,[".gitignore"])) add({id:"repo.gitignore",severity:"low",title:"Git ignore rules are missing",detail:"No root .gitignore was detected.",evidence:[".gitignore not found"],recommendation:"Ignore generated output, local environment files, dependencies, and editor state."});
  if (!workflowFiles.length) add({id:"ci.workflow",severity:"medium",title:"Continuous integration workflow not detected",detail:"No GitHub Actions workflow YAML was found under .github/workflows.",evidence:["No workflow YAML detected"],recommendation:"Add CI that runs the project's type checks, tests, and build."});
  if (!testFiles.length) add({id:"tests.files",severity:"medium",title:"Test files not detected",detail:"No files or directories matching common test naming conventions were found.",evidence:["No common test paths detected"],recommendation:"Add focused automated tests for core behavior and important failure cases."});
  if (packageJson) {
    if (!Object.keys(scripts).length) add({id:"node.scripts",severity:"low",title:"Package scripts are missing",detail:"package.json has no scripts object entries.",evidence:["package.json scripts is empty or absent"],recommendation:"Define documented scripts for development, tests, and production build."});
    if (!packageJson.engines || typeof packageJson.engines !== "object" || !("node" in packageJson.engines)) add({id:"node.engine",severity:"low",title:"Node.js engine range is unspecified",detail:"The package does not declare a Node.js compatibility range.",evidence:["package.json engines.node not found"],recommendation:"Declare and test a supported Node.js version range."});
    if (packageJson.private === true) add({id:"node.private",severity:"info",title:"Package publishing is disabled",detail:"package.json sets private=true.",evidence:["package.json private=true"],recommendation:"If publishing is intended, review the private setting; otherwise this is informational."});
  }
  if (files.has(".env")) add({id:"secrets.env",severity:"high",title:"Root .env file is present",detail:"A root environment file exists. Its contents were not read.",evidence:[".env file path detected; contents intentionally not inspected"],recommendation:"Ensure local secrets are ignored and never committed. Rotate any credentials accidentally exposed."});
  if (files.has(".env.example")) add({id:"config.env-example",severity:"info",title:"Environment template detected",detail:"A root .env.example file was found.",evidence:[".env.example"],recommendation:"Keep the template limited to placeholder names and non-secret examples."});
  if (files.has("package-lock.json") && files.has("pnpm-lock.yaml") || files.has("package-lock.json") && files.has("yarn.lock") || files.has("pnpm-lock.yaml") && files.has("yarn.lock")) add({id:"deps.lockfiles",severity:"low",title:"Multiple JavaScript lockfiles detected",detail:"More than one npm, pnpm, or Yarn lockfile exists at the root.",evidence:["Multiple root lockfiles found"],recommendation:"Choose one package manager and keep its lockfile authoritative."});
  if (files.has("tsconfig.json") && !tsStrict) add({id:"typescript.strict",severity:"low",title:"TypeScript strict mode is not confirmed",detail:"tsconfig.json does not explicitly set compilerOptions.strict=true.",evidence:["compilerOptions.strict is absent or false"],recommendation:"Consider enabling strict type checking and addressing resulting errors."});
  if (!manifests.length) add({id:"project.manifest",severity:"info",title:"Project manifest not detected",detail:"No common root manifest was found.",evidence:["Common manifest names not found"],recommendation:"Add ecosystem-appropriate metadata if this project uses a supported ecosystem."});

  const weights: Record<FindingSeverity, number> = {critical:30,high:18,medium:10,low:4,info:0};
  const penalty = findings.reduce((sum,item)=>sum+weights[item.severity],0);
  const score = Math.max(0,100-penalty);
  const grade = score>=90?"A":score>=80?"B":score>=65?"C":score>=50?"D":"F";
  return {
    root, generatedAt:new Date().toISOString(), score, grade,
    coverage:{checksPerformed:13,checksAvailable:13},
    metrics:{manifests:manifests.length,sourceFiles:sourceFiles.length,testFiles:testFiles.length,workflowFiles:workflowFiles.length},
    findings:findings.sort((a,b)=>weights[b.severity]-weights[a.severity]||a.id.localeCompare(b.id)),
    limitations:["Static heuristic checks only; no source code was executed.","Dependency vulnerabilities, code correctness, runtime behavior, and secret contents were not tested.","The score is a transparent rule-based indicator, not a certification or security rating.","Scanning is limited to 5,000 files and common root-level conventions."]
  };
}
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { const value: unknown = JSON.parse(await readFile(file,"utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : null; }
  catch { return null; }
}
export function formatQualityAudit(report: QualityAudit): string {
  const lines = [
    "# FORGE Quality Report","",`- **Project:** \`${report.root}\``,`- **Rule-based score:** \`${report.score}/100 (${report.grade})\``,`- **Checks:** \`${report.coverage.checksPerformed}/${report.coverage.checksAvailable}\``,`- **Generated:** \`${report.generatedAt}\``,"",
    "## Project metrics",`- Manifests: \`${report.metrics.manifests}\``,`- Source files: \`${report.metrics.sourceFiles}\``,`- Test files: \`${report.metrics.testFiles}\``,`- CI workflows: \`${report.metrics.workflowFiles}\``,"",
    "## Findings",...(report.findings.length?report.findings.map(item=>`### [${item.severity.toUpperCase()}] ${item.title}\n- ${item.detail}\n- Evidence: ${item.evidence.join("; ")}\n- Recommendation: ${item.recommendation}`):["No findings from the available static checks."]),"",
    "## Limitations",...report.limitations.map(item=>`- ${item}`),"", "_Generated by FORGE. This is not a security audit or certification._"
  ];
  return lines.join("\n");
}
