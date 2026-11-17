import {lstat, readFile, realpath} from "node:fs/promises";
import path from "node:path";
import type {ReviewRecord} from "./review-history.js";
export type PatchValidationStatus="applicable"|"stale"|"invalid";
export interface PatchValidationReport {reviewId:string;suggestionNumber:number;file:string;status:PatchValidationStatus;hunks:number;reason:string;}
interface Hunk {oldStart:number;oldCount:number;newCount:number;lines:string[];}
function parsePatch(patch:string,file:string):{hunks:Hunk[];reason?:string}{
 const lines=patch.replace(/\r\n/g,"\n").split("\n");
 if(lines[0]!==`--- a/${file}`||lines[1]!==`+++ b/${file}`)return {hunks:[],reason:"Patch must target exactly the reviewed file using matching a/ and b/ headers."};
 if(lines.some((line,index)=>index>1&&(line.startsWith("--- ")||line.startsWith("+++ "))))return {hunks:[],reason:"Multi-file patches are not supported."};
 const hunks:Hunk[]=[];let current:Hunk|undefined;
 for(const line of lines.slice(2)){
  if(!line){if(current)continue;continue;}
  const match=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
  if(match){current={oldStart:Number(match[1]),oldCount:match[2]===undefined?1:Number(match[2]),newCount:match[4]===undefined?1:Number(match[4]),lines:[]};hunks.push(current);continue;}
  if(!current)return {hunks:[],reason:"Unexpected content outside a unified-diff hunk."};
  if(line.startsWith("\\ No newline at end of file"))continue;
  if(![" ","+","-"].includes(line[0]??""))return {hunks:[],reason:"Unsupported unified-diff line; expected context, addition, or deletion."};
  current.lines.push(line);
 }
 if(!hunks.length)return {hunks:[],reason:"No unified-diff hunks were supplied."};
 for(const hunk of hunks){const old=hunk.lines.filter(x=>x[0]!=="+" ).length;const added=hunk.lines.filter(x=>x[0]!== "-" ).length;if(old!==hunk.oldCount||added!==hunk.newCount)return {hunks,reason:"A hunk's declared line counts do not match its contents."};}
 return {hunks};
}
export async function validateReviewPatch(root:string,record:ReviewRecord,suggestionNumber:number):Promise<PatchValidationReport>{
 const base={reviewId:record.id,suggestionNumber,file:"",status:"invalid" as PatchValidationStatus,hunks:0};
 if(!Number.isInteger(suggestionNumber)||suggestionNumber<1)return {...base,reason:"Suggestion number must be a positive, one-based integer."};
 const suggestion=record.ai?.suggestions[suggestionNumber-1];
 if(!suggestion)return {...base,reason:"That AI suggestion does not exist in this saved review."};
 const file=suggestion.file;
 const project=path.resolve(root);
 const resolved=path.resolve(project,file);
 if(!resolved.startsWith(project+path.sep))return {...base,file,reason:"Target path escapes the project directory."};
 if(!suggestion.patch)return {...base,file,reason:"This suggestion has no validated patch proposal."};
 const parsed=parsePatch(suggestion.patch,file);
 if(parsed.reason)return {...base,file,hunks:parsed.hunks.length,reason:parsed.reason};
 let source:string;
 try {
  const realProject=await realpath(project);
  const relative=path.relative(project,resolved);
  const segments=relative.split(path.sep);
  let cursor=project;
  for(let index=0;index<segments.length;index++){
   cursor=path.join(cursor,segments[index]!);
   const segmentInfo=await lstat(cursor);
   if(segmentInfo.isSymbolicLink())return {...base,file,hunks:parsed.hunks.length,reason:"Patch target path contains a symbolic link; symlinked files and parent directories are not allowed."};
   if(index<segments.length-1&&!segmentInfo.isDirectory())return {...base,file,hunks:parsed.hunks.length,status:"stale",reason:"A parent directory in the patch path is missing or is not a directory."};
   if(index===segments.length-1&&!segmentInfo.isFile())return {...base,file,hunks:parsed.hunks.length,reason:"Patch target must be a regular file, not a special file."};
  }
  const info=await lstat(resolved);
  if(info.isSymbolicLink()||!info.isFile())return {...base,file,hunks:parsed.hunks.length,reason:"Patch target must be a regular file, not a symbolic link or special file."};
  const realTarget=await realpath(resolved);
  if(!realTarget.startsWith(realProject+path.sep))return {...base,file,hunks:parsed.hunks.length,reason:"Resolved patch target escapes the real project directory."};
  source=await readFile(realTarget,"utf8");
 } catch(error) {
  const code=error&&typeof error==="object"&&"code" in error?error.code:undefined;
  if(code==="ENOENT"||code==="ENOTDIR")return {...base,file,hunks:parsed.hunks.length,status:"stale",reason:"Target file or one of its parent directories is missing; regenerate the review against the current workspace."};
  return {...base,file,hunks:parsed.hunks.length,reason:"Target file could not be safely inspected; no patch may be applied."};
 }
 const sourceLines=source.split(/\r?\n/);let previousEnd=0;
 for(const hunk of parsed.hunks){
  const start=hunk.oldStart===0?0:hunk.oldStart-1;
  if(start<previousEnd||start>sourceLines.length)return {...base,file,hunks:parsed.hunks.length,status:"stale",reason:"Hunk positions overlap or fall outside the current file."};
  let cursor=start;
  for(const line of hunk.lines){
   const marker=line[0];const text=line.slice(1);
   if(marker===" "||marker==="-"){
    if(sourceLines[cursor]!==text)return {...base,file,hunks:parsed.hunks.length,status:"stale",reason:`Source context no longer matches near line ${cursor+1}; regenerate the review against the current workspace.`};
    cursor++;
   }
  }
  previousEnd=cursor;
 }
 return {...base,file,status:"applicable",hunks:parsed.hunks.length,reason:"All patch hunks match the current file. This is a dry-run validation only; no files were changed."};
}
export function formatPatchValidation(report:PatchValidationReport):string{
 return ["# FORGE Patch Validation","- Review: "+report.reviewId,"- Suggestion: "+report.suggestionNumber,"- File: "+(report.file||"(unknown)"),"- Status: "+report.status.toUpperCase(),"- Hunks: "+report.hunks,"","## Result",report.reason,"","No source files were modified."].join("\n");
}
