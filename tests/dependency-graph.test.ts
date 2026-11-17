import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDependencyGraph } from "../src/core/dependency-graph.js";
let root = "";
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; });
describe("dependency graph", () => {
  it("connects source files to declared and undeclared package nodes", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-graph-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { express: "^5.0.0", "unused-lib": "^1.0.0" } }));
    await writeFile(path.join(root, "src", "main.ts"), "import express from 'express';\nimport missing from 'missing-package';\nimport { helper } from './helper';\nexport const app = express || missing || helper;\n");
    await writeFile(path.join(root, "src", "helper.ts"), "export const helper = true;\n");
    const graph = await buildDependencyGraph(root);
    expect(graph.nodes.find(node => node.id === "p:express")?.status).toBe("declared");
    expect(graph.nodes.find(node => node.id === "p:missing-package")?.status).toBe("undeclared");
    expect(graph.nodes.find(node => node.id === "p:unused-lib")?.status).toBe("possible-unused");
    expect(graph.edges).toContainEqual({ from: "f:src/main.ts", to: "f:src/helper.ts", kind: "internal" });
    expect(graph.edges).toContainEqual({ from: "f:src/main.ts", to: "p:express", kind: "external" });
    expect(graph.summary.undeclared).toBe(1);
    expect(graph.summary.possibleUnused).toBe(1);
  });
});
