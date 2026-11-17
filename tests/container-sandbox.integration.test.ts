import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runContainerVerification } from "../src/core/container-sandbox.js";

const image = process.env.FORGE_DOCKER_IMAGE;
let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe.skipIf(!image)("real Docker sandbox integration", () => {
  it("isolates host environment variables and excludes credential files and symlinks", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-real-docker-"));
    const project = path.join(root, "project");
    await mkdir(path.join(project, "src"), { recursive: true });
    await mkdir(path.join(root, "outside"), { recursive: true });
    await writeFile(path.join(root, "outside", "outside-secret.txt"), "must not enter the container");
    await writeFile(path.join(project, "package.json"), JSON.stringify({
      name: "forge-docker-integration",
      version: "1.0.0",
      scripts: {
        test: "node -e \"const fs=require('node:fs');const canWrite=p=>{try{fs.writeFileSync(p,'probe');fs.unlinkSync(p);return true}catch{return false}};const checks={envFile:fs.existsSync('.env'),secretFile:fs.existsSync('src/private-token.txt'),symlink:fs.existsSync('src/external-link.txt'),hostEnv:process.env.FORGE_HOST_SECRET_SENTINEL!==undefined,uid:typeof process.getuid==='function'?process.getuid():0,rootWritable:canWrite('/etc/forge-write-probe'),tmpWritable:canWrite('/tmp/forge-write-probe'),workspaceWritable:canWrite('/workspace/forge-write-probe'),snapshotWritable:canWrite('/snapshot/package.json')};console.log(JSON.stringify(checks));if(checks.envFile||checks.secretFile||checks.symlink||checks.hostEnv||checks.uid===0||checks.rootWritable||!checks.tmpWritable||!checks.workspaceWritable||checks.snapshotWritable)process.exit(9)\""
      }
    }));
    await writeFile(path.join(project, ".env"), "FORGE_TEST_SECRET=do-not-copy");
    await writeFile(path.join(project, "src", "private-token.txt"), "do-not-copy");
    await symlink(path.join(root, "outside", "outside-secret.txt"), path.join(project, "src", "external-link.txt"), "file");

    const result = await runContainerVerification(project, "test", image!, {
      timeoutMs: 60_000,
      requireRootless: process.env.FORGE_REQUIRE_ROOTLESS === "true"
    });

    expect(result.status, result.output).toBe("passed");
    expect(result.output).toContain('"envFile":false');
    expect(result.output).toContain('"secretFile":false');
    expect(result.output).toContain('"symlink":false');
    expect(result.output).toContain('"hostEnv":false');
    expect(result.output).toContain('"rootWritable":false');
    expect(result.output).toContain('"tmpWritable":true');
    expect(result.output).toContain('"workspaceWritable":true');
    expect(result.output).toContain('"snapshotWritable":false');
    expect(result.output).not.toContain('"uid":0');
    expect(result.output).toContain("network=none");
    expect(result.output).toContain("readOnlyRoot=true");
    expect(result.output).toContain("capDrop=ALL");
  }, 90_000);
});
