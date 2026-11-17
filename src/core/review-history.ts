import {mkdir,readFile,readdir,rename,rm,writeFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import path from "node:path";
import type {CodeReviewReport} from "./code-review.js";
import type {AIReviewResult} from "./ai-code-review.js";
export interface ReviewRecord {id:string;createdAt:string;report:CodeReviewReport;ai?:AIReviewResult;}
const ID=/^review-[a-f0-9-]{20,40}$/;
function directory(root:string){return path.join(path.resolve(root),".forge","reviews");}
function validateId(id:string){if(!ID.test(id)||id.includes(".."))throw new Error("Invalid review identifier.");}
export async function saveReview(root:string,report:CodeReviewReport,ai?:AIReviewResult):Promise<ReviewRecord>{
 const id="review-"+randomUUID();const record:ReviewRecord={id,createdAt:new Date().toISOString(),report,...(ai?{ai}:{})};
 const dir=directory(root);await mkdir(dir,{recursive:true});const target=path.join(dir,id+".json");const temp=path.join(dir,"."+id+"."+randomUUID()+".tmp");
 try{await writeFile(temp,JSON.stringify(record,null,2)+"\n",{encoding:"utf8",flag:"wx",mode:0o600});await rename(temp,target);}
 catch(error){await rm(temp,{force:true}).catch(()=>undefined);throw error;}
 return record;
}
export async function loadReview(root:string,id:string):Promise<ReviewRecord>{
 validateId(id);const parsed:unknown=JSON.parse(await readFile(path.join(directory(root),id+".json"),"utf8"));
 if(!parsed||typeof parsed!=="object"||!("id" in parsed)||parsed.id!==id||!("report" in parsed))throw new Error("Stored review has an invalid format.");
 return parsed as ReviewRecord;
}
export async function listReviews(root:string):Promise<ReviewRecord[]>{
 let entries;try{entries=await readdir(directory(root),{withFileTypes:true});}catch(error){if(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT")return [];throw error;}
 const records:ReviewRecord[]=[];for(const entry of entries){if(!entry.isFile()||!entry.name.endsWith(".json"))continue;const id=entry.name.slice(0,-5);if(!ID.test(id))continue;try{records.push(await loadReview(root,id));}catch{/* Ignore invalid records. */}}
 return records.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export interface ReviewComparison {added:string[];resolved:string[];persistent:string[];}
function key(f:{file:string;ruleId?:string;title:string;line:number}){return [f.file,f.ruleId??"AI",f.title].join("::");}
export function compareReviews(before:ReviewRecord,after:ReviewRecord):ReviewComparison{
 const oldFindings=[...before.report.findings,...(before.ai?.suggestions??[])];const newFindings=[...after.report.findings,...(after.ai?.suggestions??[])];
 const oldSet=new Set(oldFindings.map(key));const newSet=new Set(newFindings.map(key));
 return {added:[...newSet].filter(x=>!oldSet.has(x)).sort(),resolved:[...oldSet].filter(x=>!newSet.has(x)).sort(),persistent:[...newSet].filter(x=>oldSet.has(x)).sort()};
}
export function formatReviewRecord(record:ReviewRecord):string{
 const ai=record.ai?.suggestions.length??0;return ["# Saved FORGE Review","- ID: "+record.id,"- Created: "+record.createdAt,"- Files: "+record.report.filesReviewed.length,"- Static findings: "+record.report.findings.length,"- AI suggestions: "+ai,"",record.report.findings.map(f=>"- ["+f.severity+"] "+f.file+":"+f.line+" — "+f.title).join("\n")||"No static findings.",...(record.ai?["", "## AI suggestions",...record.ai.suggestions.flatMap(s=>["- ["+s.severity+"] "+s.file+":"+s.line+" — "+s.title,...(s.patch?["  Patch preview (not applied):","```diff",s.patch,"```"]:[])])]:[])].join("\n");
}
