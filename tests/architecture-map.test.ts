import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatArchitectureMap, mapArchitecture } from "../src/core/architecture-map.js";

describe("mapArchitecture", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });


  it("excludes source files inside hidden and private configuration directories", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-map-private-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, ".forge", "agents"), { recursive: true });
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), "export const visible = true;");
    await writeFile(path.join(root, ".forge", "agents", "private.ts"), "export const privateAgent = true;");
    await writeFile(path.join(root, ".ssh", "helper.ts"), "export const privateHelper = true;");

    const result = await mapArchitecture(root);
    expect(result.nodes.map(node => node.file)).toEqual(["src/main.ts"]);
    expect(JSON.stringify(result)).not.toContain("privateAgent");
    expect(JSON.stringify(result)).not.toContain("privateHelper");
  });

  it("maps relative imports and identifies likely entry points", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "forge-map-"));
    await mkdir(path.join(root, "src", "lib"), { recursive: true });
    await writeFile(path.join(root, "src", "main.ts"), 'import { add } from "./lib/math";\nconsole.log(add(1, 2));');
    await writeFile(path.join(root, "src", "lib", "math.ts"), "export const add = (a: number, b: number) => a + b;");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));

    const result = await mapArchitecture(root);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toContainEqual({ from: "src/main.ts", to: "src/lib/math.ts", kind: "internal" });
    expect(result.entryPoints).toContain("src/main.ts");
    expect(formatArchitectureMap(result)).toContain("# FORGE Architecture Map");
  });
});
