import {describe,expect,it} from "vitest";
import {compareCheckRuns} from "../src/core/regression-intelligence.js";
import type {VerificationResult} from "../src/core/verification.js";
function run(id:string,status:VerificationResult["status"],startedAt:string,output="",script="test"):VerificationResult{return {id,projectPath:"/tmp/demo",script,command:"npm test",status,exitCode:status==="passed"?0:1,signal:null,durationMs:1000,startedAt,finishedAt:startedAt,output,outputTruncated:false};}
describe("regression intelligence",()=>{
 it("detects a pass-to-fail regression and new failure signature",()=>{const result=compareCheckRuns([run("verify-aaaaaaa2","failed","2026-02-02","Error: assertion failed"),run("verify-aaaaaaa1","passed","2026-02-01")]);expect(result[0]?.state).toBe("regression");expect(result[0]?.newFailureSignature).toBe(true);});
 it("detects recovery and persistent failures",()=>{const result=compareCheckRuns([run("verify-aaaaaaa4","passed","2026-02-04"),run("verify-aaaaaaa3","failed","2026-02-03","Error: old"),run("verify-bbbbbbb2","failed","2026-02-02","Error: still","lint"),run("verify-bbbbbbb1","failed","2026-02-01","Error: still","lint")]);expect(result.find(x=>x.script==="test")?.state).toBe("recovered");expect(result.find(x=>x.script==="lint")?.state).toBe("persistent_failure");});
 it("marks the first recorded check as a baseline",()=>{expect(compareCheckRuns([run("verify-aaaaaaa1","passed","2026-02-01")])[0]?.state).toBe("baseline");});
});
