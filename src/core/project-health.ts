import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectProject } from "./project-inspector.js";
import { mapArchitecture } from "./architecture-map.js";
import { auditProject, type FindingSeverity } from "./quality-audit.js";
import { listVerifications } from "./verification-history.js";
import { analyzeDependencies } from "./dependency-intelligence.js";

const HISTORY_DIR = path.join(".forge", "health");
const MAX_SNAPSHOTS = 100;
export interface HealthSnapshot { id:string; generatedAt:string; engineeringScore:{score:number;grade:"A"|"B"|"C"|"D"|"F";confidencePercent:number;dimensions:Array<{id:string;label:string;weight:number;score:number|null;available:boolean;reason:string}>}; dependencySecurity:{assessed:boolean;vulnerabilities:number;critical:number;high:number;moderate:number;low:number;vulnerablePackages:number;unknownLicenses:number;copyleftLicenses:number}; quality:{score:number;grade:string;findings:number;bySeverity:Record<FindingSeverity,number>}; verification:{total:number;passed:number;failed:number;timedOut:number;spawnErrors:number;successRate:number|null;recent:Array<{script:string;status:string;durationMs:number;startedAt:string}>}; project:{files:number;directories:number;languages:Array<{name:string;files:number}>}; architecture:{nodes:number;edges:number;entryPoints:number;externalPackages:number}; }
export interface ProjectHealthReport { root:string; generatedAt:string; current:HealthSnapshot; history:HealthSnapshot[]; notes:string[]; }

async function loadSnapshots(root:string):Promise<HealthSnapshot[]> {
 const dir=path.join(path.resolve(root),HISTORY_DIR); let names:string[];
 try{names=await readdir(dir);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return[];throw error;}
 const records:HealthSnapshot[]=[];
 for(const name of names.filter(n=>/^health-[a-z0-9-]+\.json$/.test(n))){try{const item:unknown=JSON.parse(await readFile(path.join(dir,name),"utf8"));if(isSnapshot(item))records.push(item);}catch{/* Ignore malformed local history. */}}
 return records.sort((a,b)=>a.generatedAt.localeCompare(b.generatedAt)).slice(-MAX_SNAPSHOTS);
}
function isSnapshot(value:unknown):value is HealthSnapshot {
 if(!value||typeof value!=="object")return false;const v=value as Partial<HealthSnapshot>;
 return typeof v.id==="string"&&typeof v.generatedAt==="string"&&typeof v.quality?.score==="number"&&typeof v.verification?.total==="number"&&typeof v.project?.files==="number"&&typeof v.architecture?.nodes==="number";
}
export async function generateProjectHealth(inputPath:string):Promise<ProjectHealthReport>{
 const root=path.resolve(inputPath);
 const [project,audit,verification,architecture,dependencies]=await Promise.all([inspectProject(root),auditProject(root),listVerifications(root,500),mapArchitecture(root),analyzeDependencies(root)]);
 const bySeverity:Record<FindingSeverity,number>={critical:0,high:0,medium:0,low:0,info:0};
 for(const finding of audit.findings)bySeverity[finding.severity]++;
 const passed=verification.filter(v=>v.status==="passed").length;
 const completed=verification.filter(v=>v.status==="passed"||v.status==="failed").length;
 const verificationScore=verification.length ? Math.max(0,Math.round((completed?passed/completed*100:0)-Math.min(40,verification.filter(v=>v.status==="timed_out").length*10+verification.filter(v=>v.status==="spawn_error").length*15))) : null;
 const securityAssessed=dependencies.sources.vulnerabilityReport!==null;
 const securityPenalty=dependencies.summary.critical*35+dependencies.summary.high*20+dependencies.summary.moderate*8+dependencies.summary.low*2;
 const securityScore=securityAssessed?Math.max(0,100-securityPenalty):null;
 const dimensions=[
  {id:"quality",label:"Static quality",weight:50,score:audit.score,available:true,reason:"Evidence-based static project audit."},
  {id:"verification",label:"Verification reliability",weight:25,score:verificationScore,available:verificationScore!==null,reason:verificationScore===null?"No verification history is recorded.":"Based on saved verification outcomes; timeouts and spawn errors reduce the score."},
  {id:"dependency-security",label:"Dependency security",weight:25,score:securityScore,available:securityScore!==null,reason:securityScore===null?"Not assessed: provide npm-audit.json or run npm audit --json > npm-audit.json.":"Based on imported npm audit JSON findings; no live registry scan is performed."}
 ];
 const availableWeight=dimensions.filter(item=>item.available).reduce((sum,item)=>sum+item.weight,0);
 const score=availableWeight?Math.round(dimensions.reduce((sum,item)=>sum+(item.available?(item.score??0)*item.weight:0),0)/availableWeight):0;
 const grade:HealthSnapshot["engineeringScore"]["grade"]=score>=90?"A":score>=80?"B":score>=70?"C":score>=60?"D":"F";
 const now=new Date();
 const current:HealthSnapshot={
  id:"health-"+now.getTime().toString(36)+"-"+Math.random().toString(36).slice(2,7),generatedAt:now.toISOString(),
  engineeringScore:{score,grade,confidencePercent:availableWeight,dimensions},
  dependencySecurity:{assessed:securityAssessed,vulnerabilities:dependencies.summary.vulnerabilities,critical:dependencies.summary.critical,high:dependencies.summary.high,moderate:dependencies.summary.moderate,low:dependencies.summary.low,vulnerablePackages:dependencies.summary.vulnerablePackages,unknownLicenses:dependencies.summary.unknownLicenses,copyleftLicenses:dependencies.summary.copyleftLicenses},
  quality:{score:audit.score,grade:audit.grade,findings:audit.findings.length,bySeverity},
  verification:{total:verification.length,passed,failed:verification.filter(v=>v.status==="failed").length,timedOut:verification.filter(v=>v.status==="timed_out").length,spawnErrors:verification.filter(v=>v.status==="spawn_error").length,successRate:completed?Math.round(passed/completed*100):null,recent:verification.slice(0,12).map(v=>({script:v.script,status:v.status,durationMs:v.durationMs,startedAt:v.startedAt}))},
  project:{files:project.summary.filesScanned,directories:project.summary.directoriesScanned,languages:project.summary.languages.slice(0,12)},
  architecture:{nodes:architecture.nodes.length,edges:architecture.edges.length,entryPoints:architecture.entryPoints.length,externalPackages:architecture.externalPackages.length}
 };
 const dir=path.join(root,HISTORY_DIR);await mkdir(dir,{recursive:true});
 await writeFile(path.join(dir,current.id+".json"),JSON.stringify(current,null,2)+"\n",{flag:"wx",mode:0o600});
 const history=await loadSnapshots(root);
 return {root,generatedAt:current.generatedAt,current,history,notes:["Quality snapshots are recorded when this health report is requested; they are not continuous background monitoring.","Verification success rate counts passed and failed runs only; timed-out and spawn-error runs are excluded from the denominator.","The unified engineering score is a weighted, partial-coverage heuristic, not a certification. Its confidence percentage is the total weight of dimensions with available evidence.","Dependency security is assessed only when a local npm audit JSON report is present; no registry scan is performed. Architecture metrics are informational and are not used as a proxy for code quality."]};
}
export function formatProjectHealthMarkdown(report:ProjectHealthReport):string{
 const c=report.current;
 const lines=["# FORGE Project Health Report","", "- Project: `"+report.root+"`","- Generated: "+report.generatedAt,"", "## Current health","", "- Unified engineering score: **"+c.engineeringScore.score+"/100 ("+c.engineeringScore.grade+")** — evidence coverage "+c.engineeringScore.confidencePercent+"%","- Quality score: **"+c.quality.score+"/100 ("+c.quality.grade+")**","- Findings: "+c.quality.findings,"- Verification runs: "+c.verification.total, "- Verification success rate: "+(c.verification.successRate===null?"Not available":c.verification.successRate+"%"),"- Source files: "+c.project.files,"- Directories: "+c.project.directories,"- Architecture: "+c.architecture.nodes+" modules, "+c.architecture.edges+" detected imports","", "## Score dimensions", ...c.engineeringScore.dimensions.map(item=>"- "+item.label+": "+(item.score===null?"Not assessed":item.score+"/100")+" (weight "+item.weight+"%, "+(item.available?"included":"excluded")+") — "+item.reason),"", "## Dependency security", "- Assessment: "+(c.dependencySecurity.assessed?"imported npm audit report":"NOT ASSESSED"),"- Findings: "+c.dependencySecurity.vulnerabilities+" total; critical "+c.dependencySecurity.critical+", high "+c.dependencySecurity.high+", moderate "+c.dependencySecurity.moderate+", low "+c.dependencySecurity.low,"","## Quality findings by severity", ...Object.entries(c.quality.bySeverity).map(([key,value])=>"- "+key+": "+value),"", "## Language composition", ...(c.project.languages.length?c.project.languages.map(item=>"- "+item.name+": "+item.files):["- No languages detected."]),"", "## Recent verification runs", ...(c.verification.recent.length?c.verification.recent.map(item=>"- "+item.startedAt+" — "+item.script+" — "+item.status+" — "+item.durationMs+" ms"):["- No verification runs recorded."]),"", "## Quality score history", ...(report.history.length?report.history.map(item=>"- "+item.generatedAt+" — "+item.quality.score+"/100 ("+item.quality.grade+")"):["- No previous snapshots."]),"", "## Interpretation and limitations", ...report.notes.map(note=>"- "+note),""];
 return lines.join("\n");
}