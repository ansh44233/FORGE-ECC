import path from "node:path";
import {listVerifications} from "./verification-history.js";
import type {VerificationResult} from "./verification.js";
import {analyzeGitChanges} from "./git-intelligence.js";
import type {GitIntelligenceReport} from "./git-intelligence.js";
export type RegressionState="baseline"|"regression"|"recovered"|"persistent_failure"|"stable";
export interface CheckRegression {script:string;state:RegressionState;latest:VerificationResult;previous:VerificationResult|null;durationChangeMs:number|null;newFailureSignature:boolean|null;failureSignature:string|null;}
export interface RegressionReport {root:string;generatedAt:string;base:string;checks:CheckRegression[];changedFiles:Array<{status:string;file:string}>;affectedModules:Array<{file:string;affected:string[]}>;suggestedTests:Array<{file:string;reason:string}>;warnings:string[];summary:{regressions:number;recovered:number;persistentFailures:number;stable:number;baselines:number;checksReviewed:number};}
function failureSignature(output:string):string|null{
 const line=output.split(/\r?\n/).map(x=>x.trim()).find(x=>/(error|failed|failure|exception|not found|cannot find)/i.test(x));
 return line?line.replace(/\s+/g," ").slice(0,180).toLowerCase():null;
}
export function compareCheckRuns(history:VerificationResult[]):CheckRegression[]{
 const groups=new Map<string,VerificationResult[]>();
 for(const item of [...history].sort((a,b)=>b.startedAt.localeCompare(a.startedAt))){
  const group=groups.get(item.script)??[];group.push(item);groups.set(item.script,group);
 }
 return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([script,runs])=>{
  const latest=runs[0]!;const previous=runs[1]??null;
  let state:RegressionState="baseline";
  if(previous){
   const latestPass=latest.status==="passed";const previousPass=previous.status==="passed";
   state=latestPass?(previousPass?"stable":"recovered"):(previousPass?"regression":"persistent_failure");
  }
  const latestSignature=failureSignature(latest.output);const previousSignature=previous?failureSignature(previous.output):null;
  return {script,state,latest,previous,durationChangeMs:previous?latest.durationMs-previous.durationMs:null,newFailureSignature:previous?Boolean(latestSignature&&latestSignature!==previousSignature):null,failureSignature:latestSignature};
 });
}
export async function generateRegressionReport(inputPath:string,base="HEAD"):Promise<RegressionReport>{
 const root=path.resolve(inputPath);const warnings:string[]=[];
 const history=await listVerifications(root,500);const checks=compareCheckRuns(history);
 let git:GitIntelligenceReport|undefined;
 try{git=await analyzeGitChanges(root,base);warnings.push(...git.warnings);}
 catch{warnings.push("Git change context unavailable. Run this command inside a Git repository with the requested base revision available.");}
 const changedFiles=git?.changes??[];const affectedModules=git?.impact??[];const suggestedTests=git?.suggestedTests??[];
 if(!history.length)warnings.push("No saved verification runs exist yet. Run selected checks with 'forge verify SCRIPT' to establish a baseline.");
 if(history.length===500)warnings.push("Only the latest 500 verification records were considered.");
 const summary={regressions:checks.filter(x=>x.state==="regression").length,recovered:checks.filter(x=>x.state==="recovered").length,persistentFailures:checks.filter(x=>x.state==="persistent_failure").length,stable:checks.filter(x=>x.state==="stable").length,baselines:checks.filter(x=>x.state==="baseline").length,checksReviewed:checks.length};
 return {root,generatedAt:new Date().toISOString(),base,checks,changedFiles,affectedModules,suggestedTests,warnings,summary};
}
export function formatRegressionReport(report:RegressionReport):string{
 const checkLine=(item:CheckRegression)=>"- **"+item.script+"**: "+item.state.toUpperCase()+(item.previous?" ("+item.previous.status+" → "+item.latest.status+")":" (baseline)")+(item.durationChangeMs===null?"":"; duration "+(item.durationChangeMs>=0?"+":"")+item.durationChangeMs+" ms")+(item.newFailureSignature?" [new failure signature]":"");
 return ["# FORGE Regression Intelligence","", "- Project: `"+report.root+"`","- Compared against Git base: `"+report.base+"`","- Verification records: "+report.summary.checksReviewed,"","## Summary","- Regressions: "+report.summary.regressions,"- Recovered: "+report.summary.recovered,"- Persistent failures: "+report.summary.persistentFailures,"- Stable: "+report.summary.stable,"- Baselines: "+report.summary.baselines,"","## Check comparisons",...(report.checks.length?report.checks.map(checkLine):["- No verification history available."]),"","## Changed files",...(report.changedFiles.length?report.changedFiles.map(x=>"- ["+x.status+"] `"+x.file+"`"):["- No Git changes detected or Git context unavailable."]),"","## Potentially affected modules",...(report.affectedModules.length?report.affectedModules.map(x=>"- `"+x.file+"` may affect: "+x.affected.map(f=>"`"+f+"`").join(", ")):["- No downstream impact paths detected."]),"","## Suggested test targets",...(report.suggestedTests.length?report.suggestedTests.map(x=>"- `"+x.file+"` — "+x.reason):["- No test targets inferred from changed files."]),"","## Warnings",...(report.warnings.length?report.warnings.map(x=>"- "+x):["- None."]),"","_Regression signals compare saved command outcomes; they do not prove causation. Suggested tests are heuristic and are not executed by this command._"].join("\n");
}
