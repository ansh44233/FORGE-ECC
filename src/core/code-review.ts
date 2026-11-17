import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyzeGitChanges } from "./git-intelligence.js";

export type ReviewSeverity="high"|"medium"|"low";
export interface ReviewFinding { ruleId:string; severity:ReviewSeverity; file:string; line:number; title:string; evidence:string; recommendation:string; confidence:"heuristic"; }
export interface CodeReviewReport { root:string; generatedAt:string; scope:"changed-files"|"source-files"; base:string; filesReviewed:string[]; findings:ReviewFinding[]; summary:{high:number;medium:number;low:number}; warnings:string[]; }
const SOURCE=/\.(?:[cm]?[jt]sx?)$/i;
const SKIP=new Set(["node_modules",".git","dist","build","coverage",".next",".forge"]);
async function walk(dir:string,root:string,out:string[],depth=0):Promise<void>{
 if(depth>12)return;
 const {readdir}=await import("node:fs/promises");
 let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
 for(const entry of entries){if(entry.name.startsWith(".")&&entry.name!==".")continue;if(SKIP.has(entry.name))continue;
  const full=path.join(dir,entry.name);if(entry.isDirectory())await walk(full,root,out,depth+1);else if(entry.isFile()&&SOURCE.test(entry.name))out.push(path.relative(root,full).split(path.sep).join("/"));
 }
}
function inspectLines(file:string,source:string):ReviewFinding[]{
 const findings:ReviewFinding[]=[];const lines=source.split(/\r?\n/);
 const rules:Array<{id:string;severity:ReviewSeverity;title:string;pattern:RegExp;recommendation:string}>= [
  {id:"FORGE-R001",severity:"high",title:"Dynamic code evaluation",pattern:/\beval\s*\(|\bnew\s+Function\s*\(/,recommendation:"Avoid evaluating generated strings. Prefer explicit parsers or allow-listed operations."},
  {id:"FORGE-R002",severity:"medium",title:"Shell execution API usage",pattern:/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\s*\(/,recommendation:"Review argument handling, executable allow-lists, and whether shell mode is enabled. Prefer argument arrays and avoid shell interpolation."},
  {id:"FORGE-R003",severity:"medium",title:"HTML injection sink",pattern:/\.(?:innerHTML|outerHTML)\s*=/,recommendation:"Avoid assigning untrusted strings to HTML sinks. Use textContent or a vetted sanitizer."},
  {id:"FORGE-R004",severity:"low",title:"TypeScript error suppression",pattern:/@ts-ignore\b/,recommendation:"Prefer @ts-expect-error with an explanation, or correct the underlying type mismatch."},
  {id:"FORGE-R005",severity:"low",title:"Potentially empty catch block",pattern:/catch\s*(?:\([^)]*\))?\s*\{\s*\}/,recommendation:"Handle, report, or deliberately document the error instead of silently discarding it."},
  {id:"FORGE-R006",severity:"medium",title:"Dangerously injected HTML property",pattern:/dangerouslySetInnerHTML/,recommendation:"Ensure content is trusted or sanitized immediately before rendering."}
 ];
 for(let i=0;i<lines.length;i++){const line=lines[i] ?? "";if(/^\s*(?:\/\/|\*|\*)/.test(line))continue;for(const rule of rules)if(rule.pattern.test(line))findings.push({ruleId:rule.id,severity:rule.severity,file,line:i+1,title:rule.title,evidence:line.trim().slice(0,240),recommendation:rule.recommendation,confidence:"heuristic"});}
 return findings;
}
export async function reviewProject(inputPath:string,options:{base?:string;all?:boolean}={}):Promise<CodeReviewReport>{
 const root=path.resolve(inputPath);const warnings:string[]=[];let files:string[]=[];let scope:CodeReviewReport["scope"]="changed-files";const base=options.base??"HEAD";
 if(options.all){scope="source-files";await walk(root,root,files);}
 else{const git=await analyzeGitChanges(root,base);files=git.changes.filter(c=>c.status!=="D"&&SOURCE.test(c.file)).map(c=>c.file);if(!files.length){warnings.push("No changed source files found. Use --all to review the source tree.");}}
 files=[...new Set(files)].sort();const findings:ReviewFinding[]=[];
 for(const file of files){try{const full=path.resolve(root,file);if(!full.startsWith(root+path.sep))continue;const source=await readFile(full,"utf8");findings.push(...inspectLines(file,source));}catch{warnings.push("Could not read "+file+".");}}
 const summary={high:findings.filter(f=>f.severity==="high").length,medium:findings.filter(f=>f.severity==="medium").length,low:findings.filter(f=>f.severity==="low").length};
 return {root,generatedAt:new Date().toISOString(),scope,base,filesReviewed:files,findings,summary,warnings};
}
export function formatCodeReview(report:CodeReviewReport):string{
 return ["# FORGE Code Review","", "- Scope: "+report.scope,"- Files reviewed: "+report.filesReviewed.length,"- Findings: "+report.findings.length+" (high "+report.summary.high+", medium "+report.summary.medium+", low "+report.summary.low+")","",
 "## Findings",...(report.findings.length?report.findings.map(f=>"- **"+f.severity.toUpperCase()+" "+f.ruleId+"** — `"+f.file+":"+f.line+"`: "+f.title+"\n  Evidence: `"+f.evidence+"`\n  Recommendation: "+f.recommendation):["- No configured heuristic patterns detected."]),"",
 "## Files reviewed",...(report.filesReviewed.length?report.filesReviewed.map(f=>"- `"+f+"`"):["- None."]),"",
 "## Method and limitations","- This is deterministic pattern-based triage, not an AI review, compiler analysis, or security audit.",
 "- Findings are heuristic candidates and may be false positives; absence of findings does not prove correctness or safety.",
 "- Review scope defaults to changed, non-deleted source files relative to the selected Git base. Use --all to scan the source tree.",
 ...report.warnings.map(w=>"- "+w)].join("\n");
}
