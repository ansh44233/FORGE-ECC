import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeDependencies, formatDependencyIntelligence } from "../src/core/dependency-intelligence.js";
let root="";
afterEach(async()=>{if(root)await rm(root,{recursive:true,force:true});root="";});
describe("dependency intelligence",()=>{
 it("inventories npm direct and transitive packages and marks missing assessments honestly",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-deps-"));
  await writeFile(path.join(root,"package.json"),JSON.stringify({dependencies:{alpha:"^1.0.0"},devDependencies:{beta:"~2.0.0"}}));
  await writeFile(path.join(root,"package-lock.json"),JSON.stringify({lockfileVersion:3,packages:{"":{name:"fixture"},"node_modules/alpha":{version:"1.2.0",license:"MIT"},"node_modules/beta":{version:"2.1.0"},"node_modules/parent/node_modules/child":{version:"3.0.0"}}}));
  const report=await analyzeDependencies(root);
  expect(report.summary.direct).toBe(2);
  expect(report.summary.transitive).toBe(1);
  expect(report.summary.unknownLicenses).toBe(2);
  expect(report.sources.vulnerabilityReport).toBeNull();
  expect(formatDependencyIntelligence(report)).toContain("NOT ASSESSED");
 });
 it("imports npm audit and outdated JSON without executing commands",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-deps-"));
  await writeFile(path.join(root,"package.json"),JSON.stringify({dependencies:{alpha:"^1.0.0"}}));
  await writeFile(path.join(root,"package-lock.json"),JSON.stringify({lockfileVersion:3,packages:{"node_modules/alpha":{version:"1.0.0",license:"MIT"}}}));
  await writeFile(path.join(root,"audit.json"),JSON.stringify({vulnerabilities:{alpha:{severity:"high",via:[{title:"Example advisory",severity:"high",range:"<1.1.0"}],fixAvailable:true}}}));
  await writeFile(path.join(root,"outdated.json"),JSON.stringify({alpha:{current:"1.0.0",wanted:"1.2.0",latest:"2.0.0"}}));
  const report=await analyzeDependencies(root,{auditReport:"audit.json",outdatedReport:"outdated.json"});
  expect(report.summary.vulnerablePackages).toBe(1);
  expect(report.summary.high).toBe(1);
  expect(report.dependencies[0]?.outdated?.latest).toBe("2.0.0");
  expect(report.dependencies[0]?.licenseClass).toBe("permissive");
 });
 it("rejects report paths outside the project",async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"forge-deps-"));
  await expect(analyzeDependencies(root,{auditReport:"../outside.json"})).rejects.toThrow("inside the project");
 });
});
