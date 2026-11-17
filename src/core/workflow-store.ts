import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRun, type AgentTask, type RunRecord } from "./orchestrator.js";

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  tasks: AgentTask[];
  positions?: Record<string, { x: number; y: number }>;
  updatedAt: string;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

function validateWorkflow(input: unknown): asserts input is Omit<WorkflowDefinition, "updatedAt"> {
  if (!input || typeof input !== "object") throw new Error("Workflow must be an object.");
  const value = input as Record<string, unknown>;
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) throw new Error("Workflow id must be a 2–48 character lowercase slug.");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 100) throw new Error("Workflow name is required and must be at most 100 characters.");
  if (typeof value.description !== "string" || value.description.length > 500) throw new Error("Workflow description must be at most 500 characters.");
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 30) throw new Error("A workflow must contain between 1 and 30 tasks.");
  const tasks = value.tasks as AgentTask[];
  const ids = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== "object" || typeof task.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(task.id)) throw new Error("Each task needs a valid lowercase id.");
    if (ids.has(task.id)) throw new Error("Task ids must be unique.");
    ids.add(task.id);
    if (typeof task.agent !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(task.agent)) throw new Error("Each task needs a valid agent id.");
    if (typeof task.title !== "string" || !task.title.trim() || task.title.length > 120) throw new Error("Task titles are required and limited to 120 characters.");
    if (typeof task.prompt !== "string" || !task.prompt.trim() || task.prompt.length > 4000) throw new Error("Task prompts are required and limited to 4,000 characters.");
    if (task.requiresApproval !== undefined && typeof task.requiresApproval !== "boolean") throw new Error("requiresApproval must be boolean.");
    if (task.dependsOn !== undefined && (!Array.isArray(task.dependsOn) || task.dependsOn.some(id => typeof id !== "string"))) throw new Error("dependsOn must be a list of task ids.");
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (!ids.has(dependency) || dependency === task.id) throw new Error("Task dependencies must reference another task in this workflow.");
    }
  }
  if (value.positions !== undefined) {
    if (!value.positions || typeof value.positions !== "object" || Array.isArray(value.positions)) throw new Error("Workflow positions must be a map.");
    for (const [taskId, point] of Object.entries(value.positions as Record<string, unknown>)) {
      if (!ids.has(taskId) || !point || typeof point !== "object") throw new Error("Workflow positions must reference existing tasks.");
      const position = point as { x?: number; y?: number };
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || position.x! < 0 || position.x! > 4000 || position.y! < 0 || position.y! > 3000) throw new Error("Workflow position is outside the supported canvas.");
    }
  }
  // Reuse the run planner's cycle and dependency validation.
  createRun(value.name, tasks);
}

function directory(projectPath: string): string {
  return path.join(path.resolve(projectPath), ".forge", "workflows");
}

export async function saveWorkflow(projectPath: string, input: unknown): Promise<WorkflowDefinition> {
  validateWorkflow(input);
  const workflow = { ...input, tasks: input.tasks.map(task => ({ ...task, dependsOn: [...(task.dependsOn ?? [])] })), updatedAt: new Date().toISOString() };
  const folder = directory(projectPath);
  await mkdir(folder, { recursive: true });
  const destination = path.join(folder, workflow.id + ".json");
  const temporary = path.join(folder, "." + workflow.id + "." + randomUUID() + ".tmp");
  try {
    await writeFile(temporary, JSON.stringify(workflow, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return workflow;
}

export async function loadWorkflow(projectPath: string, id: string): Promise<WorkflowDefinition> {
  if (!ID_PATTERN.test(id)) throw new Error("Invalid workflow identifier.");
  const value: unknown = JSON.parse(await readFile(path.join(directory(projectPath), id + ".json"), "utf8"));
  validateWorkflow(value);
  if (value.id !== id) throw new Error("Stored workflow identifier does not match its filename.");
  return value as WorkflowDefinition;
}

export async function listWorkflows(projectPath: string): Promise<WorkflowDefinition[]> {
  let entries;
  try { entries = await readdir(directory(projectPath), { withFileTypes: true }); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const workflows: WorkflowDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -5);
    if (!ID_PATTERN.test(id)) continue;
    try { workflows.push(await loadWorkflow(projectPath, id)); } catch { /* Ignore malformed local definitions. */ }
  }
  return workflows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createRunFromWorkflow(workflow: WorkflowDefinition): RunRecord {
  return createRun(workflow.name, workflow.tasks);
}
