import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverChecks, runVerification, formatVerificationResult, installVerificationDependencies } from "../src/core/verification.js";

describe("verification engine",()=>{
 let root="";
 afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root="";});
 async function setup(scripts:Record<string,string>){root=await mkdtemp(path.join(os.tmpdir(),"forge-verify-"));await writeFile(path.join(root,"package.json"),JSON.stringify({scripts}));}
 it("discovers named checks and hides lifecycle hooks",async()=>{
  await setup({test:"vitest run",build:"tsc",pretest:"echo before",posttest:"echo after"});
  expect((await discoverChecks(root)).map(item=>item.name)).toEqual(["build","test"]);
 });
 it("rejects unknown and lifecycle scripts without executing anything",async()=>{
  await setup({test:"node -e \"process.exit(0)\"",pretest:"echo unsafe"});
  await expect(runVerification(root,"missing")).rejects.toThrow(/not defined/);
  await expect(runVerification(root,"pretest")).rejects.toThrow(/valid, explicit/);
 });
 it("executes only the selected script and records its actual exit code",async()=>{
  await setup({verify:"node -e \"console.log('FORGE_CHECK_OK')\""});
  const result=await runVerification(root,"verify");
  expect(result.status).toBe("passed");
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("FORGE_CHECK_OK");
  expect(formatVerificationResult(result)).toContain("PASSED");
 });
 it("does not forward arbitrary environment secrets to project scripts",async()=>{
  await setup({verify:"node -e \"console.log(process.env.FORGE_TEST_SECRET || 'NOT_FORWARDED')\""});
  process.env.FORGE_TEST_SECRET="test-secret-value";
  try {
   const result=await runVerification(root,"verify");
   expect(result.output).toContain("NOT_FORWARDED");
   expect(result.output).not.toContain("test-secret-value");
  } finally { delete process.env.FORGE_TEST_SECRET; }
 });
 it("records a failing script as failed",async()=>{
  await setup({verify:"node -e \"process.exit(7)\""});
  const result=await runVerification(root,"verify");
  expect(result.status).toBe("failed");
  expect(result.exitCode).toBe(7);
 });
 it("requires a regular lockfile before dependency preparation",async()=>{
  await setup({verify:"node -e \"process.exit(0)\""});
  await expect(installVerificationDependencies(root)).rejects.toThrow(/requires a regular package-lock.json/);
 });
 it("validates dependency installation timeout before spawning npm",async()=>{
  await setup({verify:"node -e \"process.exit(0)\""});
  await writeFile(path.join(root,"package-lock.json"),JSON.stringify({name:"fixture",lockfileVersion:3,packages:{}}));
  await expect(installVerificationDependencies(root,{timeoutMs:999})).rejects.toThrow(/between 1,000 and 600,000/);
 });
});
