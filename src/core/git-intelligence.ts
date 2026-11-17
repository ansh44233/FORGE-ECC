import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { analyzeCodebase } from "./code-intelligence.js";

const execFileAsync=promisify(execFile);
export interface GitChange { status:string; file:string; }
export interface GitIntelligenceReport {
 root:string; generatedAt:string; branch:string; base:string;
 changes:GitChange[];
 impact:Array<{file:string;affected:string[]}>;
 suggestedTests:Array<{file:string;reason:string}>;
 risk:{level:"low"|"moderate"|"high";reasons:string[]};
 warnings:string[];
}
async function git(root:string,args:string[]):Promise<string>{
 const result=await execFileAsync("git",["-C",root,...args],{encoding:"utf8",timeout:15000,maxBuffer:2*1024*1024});
 return result.stdout;
}
function testSuggestion(file:string):{file:string;reason:string}|undefined{
 if(/(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[jt]sx?$/.test(file))return;
 const base=path.posix.basename(file).replace(/\.[^.]+$/,"");
 const ext=path.posix.extname(file);
 if(![".ts",".tsx",".js",".jsx"].includes(ext))return;
 return {file:"tests/"+base+".test.ts",reason:"Review or update tests for the changed module "+file+"."};
}
export async function analyzeGitChanges(inputPath:string,base="HEAD"):Promise<GitIntelligenceReport>{
 const root=path.resolve(inputPath);
 const warnings:string[]=[];
 const branch=(await git(root,["branch","--show-current"])).trim()||"(detached HEAD)";
 if(typeof base!=="string"||!base.trim()||base.length>200)throw new Error("Base revision must be a non-empty Git revision up to 200 characters.");
 let diff:string;
 try{
  const revision=(await git(root,["rev-parse","--verify","--end-of-options",base+"^{commit}"])).trim();
  if(!/^[0-9a-f]{40,64}$/i.test(revision))throw new Error("Invalid resolved revision.");
  diff=await git(root,["diff","--no-ext-diff","--no-textconv","--name-status","-M",revision]);
 }
 catch{throw new Error("Git diff failed. Ensure the base is a valid commit revision in this repository.");}
 const changes:GitChange[]=diff.split(/\r?\n/).filter(Boolean).map(line=>{
  const [status,...names]=line.split("\t");
  return {status:status??"?",file:names.at(-1)??""};
 }).filter(change=>Boolean(change.file));
 const untracked=(await git(root,["ls-files","--others","--exclude-standard"])).split(/\r?\n/).filter(Boolean);
 const known=new Set(changes.map(c=>c.file));
 for(const file of untracked)if(!known.has(file))changes.push({status:"?",file});
 changes.sort((a,b)=>a.file.localeCompare(b.file));
 let impact:GitIntelligenceReport["impact"]=[];
 try{
  const architecture=await analyzeCodebase(root);
  const byFile=new Map(architecture.impact.map(item=>[item.file,item.affected]));
  impact=changes.filter(c=>c.status!=="D").map(c=>({file:c.file,affected:byFile.get(c.file)??[]})).filter(item=>item.affected.length);
  warnings.push(...architecture.warnings);
 }catch{warnings.push("Architecture impact could not be calculated for this working tree.");}
 const suggestedTests=changes.map(c=>testSuggestion(c.file)).filter((v):v is {file:string;reason:string}=>Boolean(v));
 const reasons:string[]=[];
 for(const change of changes){
  const file=change.file.toLowerCase();
  if(/(^|\/)(auth|security|crypto|permissions?)(\/|\.)/.test(file))reasons.push("Security-sensitive path changed: "+change.file);
  if(/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json|tsconfig[^/]*\.json|vite\.config\.[jt]s)$/.test(file))reasons.push("Dependency or build configuration changed: "+change.file);
  if(change.status==="D")reasons.push("Tracked file deleted: "+change.file);
 }
 if(changes.length>=10)reasons.push("Large change set: "+changes.length+" files.");
 const level=reasons.some(r=>r.startsWith("Security-sensitive")||r.startsWith("Tracked file deleted"))?"high":reasons.length?"moderate":"low";
 if(!changes.length)warnings.push("No differences from the selected base revision and no untracked files were found.");
 return {root,generatedAt:new Date().toISOString(),branch,base,changes,impact,suggestedTests,risk:{level,reasons:[...new Set(reasons)]},warnings};
}
export function formatGitIntelligence(report:GitIntelligenceReport):string{
 return ["# FORGE Git Intelligence","", "- Branch: "+report.branch,"- Compared with: "+report.base,"- Changed files: "+report.changes.length,"- Risk estimate: "+report.risk.level.toUpperCase(),"",
 "## Changes",...(report.changes.length?report.changes.map(c=>"- ["+c.status+"] `"+c.file+"`"):["- Working tree matches the selected base."]),"",
 "## Downstream impact",...(report.impact.length?report.impact.map(i=>"- `"+i.file+"` may affect: "+i.affected.map(f=>"`"+f+"`").join(", ")):["- No downstream imports identified for changed files."]),"",
 "## Suggested tests",...(report.suggestedTests.length?report.suggestedTests.map(t=>"- `"+t.file+"` — "+t.reason):["- No source-file test suggestions generated."]),"",
 "## Risk reasons",...(report.risk.reasons.length?report.risk.reasons.map(r=>"- "+r):["- No configured high-risk patterns detected."]),"",
 "## Limitations","- Git diff and untracked-file inspection only; ignored files are excluded.",
 "- Risk labels are heuristics, not security assessments. Suggested tests are candidates, not automatically run.",
 "- Impact depends on FORGE's static relative-import resolver; aliases and runtime dependencies may be missed.",
 ...report.warnings.map(w=>"- "+w)].join("\n");
}
