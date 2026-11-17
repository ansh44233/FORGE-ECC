import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isExcludedScanDirectory } from "./workspace-scan-policy.js";

const IGNORED_DIRECTORIES = { has: isExcludedScanDirectory };

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript",
  ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java",
  ".kt": "Kotlin", ".swift": "Swift", ".c": "C", ".h": "C/C++",
  ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".php": "PHP",
  ".rb": "Ruby", ".vue": "Vue", ".svelte": "Svelte", ".html": "HTML",
  ".css": "CSS", ".scss": "SCSS", ".json": "JSON", ".md": "Markdown",
  ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML", ".sh": "Shell",
  ".sql": "SQL", ".xml": "XML", ".dart": "Dart"
};

const IMPORTANT_FILES = [
  "README.md", "package.json", "tsconfig.json", "pyproject.toml",
  "requirements.txt", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "Dockerfile", "docker-compose.yml",
  "compose.yml", ".env.example", ".github/workflows"
];

export interface ProjectReport {
  root: string;
  generatedAt: string;
  summary: {
    filesScanned: number;
    directoriesScanned: number;
    languages: Array<{ name: string; files: number }>;
  };
  packageManagers: string[];
  frameworks: string[];
  scripts: Record<string, string>;
  dependencies: { production: number; development: number };
  importantFiles: string[];
  topLevel: string[];
  warnings: string[];
}

interface WalkResult {
  files: string[];
  directories: string[];
  truncated: boolean;
}

async function walk(root: string, relative = "", result: WalkResult = {
  files: [], directories: [], truncated: false
}): Promise<WalkResult> {
  if (result.files.length >= 5000) {
    result.truncated = true;
    return result;
  }

  let entries;
  try {
    entries = await readdir(path.join(root, relative), { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (result.files.length >= 5000) {
      result.truncated = true;
      break;
    }

    const child = path.posix.join(relative.split(path.sep).join("/"), entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      result.directories.push(child);
      await walk(root, path.join(relative, entry.name), result);
    } else if (entry.isFile()) {
      result.files.push(child);
    }
  }
  return result;
}

function detectFrameworks(pkg: Record<string, unknown> | null): string[] {
  if (!pkg) return [];
  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {})
  };
  const known: Record<string, string> = {
    next: "Next.js", react: "React", vue: "Vue", svelte: "Svelte",
    "@angular/core": "Angular", express: "Express", fastify: "Fastify",
    nestjs: "NestJS", "@nestjs/core": "NestJS", vite: "Vite",
    astro: "Astro", electron: "Electron", "react-native": "React Native",
    expo: "Expo", tailwindcss: "Tailwind CSS", prisma: "Prisma",
    "@prisma/client": "Prisma", "drizzle-orm": "Drizzle ORM"
  };
  return [...new Set(Object.keys(known).flatMap(key =>
    deps[key] && known[key] ? [known[key]] : []
  ))].sort();
}

export async function inspectProject(inputPath: string): Promise<ProjectReport> {
  const root = path.resolve(inputPath);
  const walkResult = await walk(root);
  const extensionCounts = new Map<string, number>();

  for (const file of walkResult.files) {
    const extension = path.extname(file).toLowerCase();
    const language = LANGUAGE_BY_EXTENSION[extension];
    if (language) extensionCounts.set(language, (extensionCounts.get(language) ?? 0) + 1);
  }

  const readJson = async (file: string): Promise<Record<string, unknown> | null> => {
    try {
      return JSON.parse(await readFile(path.join(root, file), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const pkg = await readJson("package.json");
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};
  const production = (pkg?.dependencies as Record<string, unknown> | undefined) ?? {};
  const development = (pkg?.devDependencies as Record<string, unknown> | undefined) ?? {};
  const fileSet = new Set(walkResult.files);
  const directorySet = new Set(walkResult.directories);
  const importantFiles = IMPORTANT_FILES.filter(item =>
    item.endsWith("/") ? directorySet.has(item.replace(/\/$/, "")) :
      fileSet.has(item) || (item === ".github/workflows" && directorySet.has(".github/workflows"))
  );

  const packageManagers: string[] = [];
  if (fileSet.has("package-lock.json")) packageManagers.push("npm");
  if (fileSet.has("pnpm-lock.yaml")) packageManagers.push("pnpm");
  if (fileSet.has("yarn.lock")) packageManagers.push("Yarn");
  if (fileSet.has("bun.lock") || fileSet.has("bun.lockb")) packageManagers.push("Bun");
  if (fileSet.has("pyproject.toml") || fileSet.has("requirements.txt")) packageManagers.push("Python / pip");
  if (fileSet.has("Cargo.toml")) packageManagers.push("Cargo");
  if (fileSet.has("go.mod")) packageManagers.push("Go modules");

  const warnings: string[] = [];
  if (walkResult.truncated) warnings.push("File scan reached the 5,000-file safety limit; results may be incomplete.");
  if (!pkg && !fileSet.has("pyproject.toml") && !fileSet.has("Cargo.toml") && !fileSet.has("go.mod")) {
    warnings.push("No common project manifest was detected. Some ecosystem details may be unavailable.");
  }
  if (fileSet.has(".env")) warnings.push("A .env file exists. Keep credentials out of version control.");

  return {
    root,
    generatedAt: new Date().toISOString(),
    summary: {
      filesScanned: walkResult.files.length,
      directoriesScanned: walkResult.directories.length,
      languages: [...extensionCounts.entries()]
        .map(([name, files]) => ({ name, files }))
        .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    },
    packageManagers,
    frameworks: detectFrameworks(pkg),
    scripts: Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => a.localeCompare(b))),
    dependencies: { production: Object.keys(production).length, development: Object.keys(development).length },
    importantFiles,
    topLevel: [...new Set(walkResult.files.map(file => file.split("/")[0] ?? file))].sort(),
    warnings
  };
}

export function formatProjectReport(report: ProjectReport): string {
  const lines = [
    "# FORGE Project Intelligence",
    "",
    `- **Root:** \`${report.root}\``,
    `- **Files scanned:** ${report.summary.filesScanned}`,
    `- **Directories scanned:** ${report.summary.directoriesScanned}`,
    "",
    "## Language composition",
    ...(report.summary.languages.length
      ? report.summary.languages.map(item => `- ${item.name}: ${item.files} files`)
      : ["- No recognized source files found."]),
    "",
    "## Ecosystem",
    `- **Package managers:** ${report.packageManagers.join(", ") || "Not detected"}`,
    `- **Frameworks / tools:** ${report.frameworks.join(", ") || "Not detected"}`,
    `- **Dependencies:** ${report.dependencies.production} production, ${report.dependencies.development} development`,
    "",
    "## Available scripts",
    ...(Object.entries(report.scripts).length
      ? Object.entries(report.scripts).map(([name, command]) => `- \`${name}\`: \`${command}\``)
      : ["- No package scripts detected."]),
    "",
    "## Important project files",
    ...(report.importantFiles.length ? report.importantFiles.map(file => `- \`${file}\``) : ["- None detected."]),
    "",
    "## Top-level entries",
    ...(report.topLevel.length ? report.topLevel.map(item => `- \`${item}\``) : ["- No files detected."]),
    "",
    "## Notes",
    ...(report.warnings.length ? report.warnings.map(warning => `- ${warning}`) : ["- No scan warnings."]),
    "",
    `_Generated by FORGE at ${report.generatedAt}. This report describes detected files; it is not a security audit._`
  ];
  return lines.join("\n");
}
