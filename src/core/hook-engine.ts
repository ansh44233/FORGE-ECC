import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentTask } from "./orchestrator.js";

export type HookEvent = "before-agent";
export type HookAction = "require-approval" | "append-context" | "block-task";

export interface ForgeHook {
  id: string;
  event: HookEvent;
  action: HookAction;
  match?: { agents?: string[]; contains?: string[] };
  message: string;
  enabled?: boolean;
}

export interface HookResult {
  task: AgentTask;
  context: string[];
  blockedReason?: string;
  approvalRequired: boolean;
  triggered: string[];
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validateHooks(value: unknown): ForgeHook[] {
  if (!Array.isArray(value)) throw new Error("Hook configuration must be a JSON array.");
  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Hook ${index} must be an object.`);
    const hook = item as Partial<ForgeHook>;
    if (typeof hook.id !== "string" || !ID.test(hook.id)) throw new Error(`Hook ${index} has an invalid id.`);
    if (ids.has(hook.id)) throw new Error(`Hook ${hook.id} is duplicated.`);
    ids.add(hook.id);
    if (hook.event !== "before-agent") throw new Error(`Hook ${hook.id} uses an unsupported event.`);
    if (!["require-approval", "append-context", "block-task"].includes(hook.action ?? "")) throw new Error(`Hook ${hook.id} uses an unsupported action.`);
    if (typeof hook.message !== "string" || !hook.message.trim() || hook.message.length > 2000) throw new Error(`Hook ${hook.id} needs a message of 1–2000 characters.`);
    if (hook.enabled !== undefined && typeof hook.enabled !== "boolean") throw new Error(`Hook ${hook.id} has an invalid enabled flag.`);
    if (hook.match !== undefined && (!hook.match || typeof hook.match !== "object" || Array.isArray(hook.match))) throw new Error(`Hook ${hook.id} has invalid match filters.`);
    if (hook.match?.agents !== undefined && (!Array.isArray(hook.match.agents) || hook.match.agents.some(agent => typeof agent !== "string" || !agent.trim()))) throw new Error(`Hook ${hook.id} has invalid agent filters.`);
    if (hook.match?.contains !== undefined && (!Array.isArray(hook.match.contains) || hook.match.contains.some(term => typeof term !== "string" || !term.trim()))) throw new Error(`Hook ${hook.id} has invalid text filters.`);
    return hook as ForgeHook;
  });
}

export async function loadHooks(projectPath: string): Promise<ForgeHook[]> {
  const file = path.join(path.resolve(projectPath), ".forge", "hooks.json");
  try { return validateHooks(JSON.parse(await readFile(file, "utf8"))); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

export function applyBeforeAgentHooks(task: AgentTask, hooks: readonly ForgeHook[]): HookResult {
  const context: string[] = [];
  const triggered: string[] = [];
  let blockedReason: string | undefined;
  let approvalRequired = Boolean(task.requiresApproval);
  const haystack = (task.title + " " + task.prompt).toLowerCase();
  for (const hook of hooks) {
    if (hook.enabled === false || hook.event !== "before-agent") continue;
    if (hook.match?.agents?.length && !hook.match.agents.includes(task.agent)) continue;
    if (hook.match?.contains?.length && !hook.match.contains.some(term => haystack.includes(term.toLowerCase()))) continue;
    triggered.push(hook.id);
    if (hook.action === "require-approval") approvalRequired = true;
    if (hook.action === "append-context") context.push(hook.message);
    if (hook.action === "block-task") blockedReason ??= hook.message;
  }
  return {
    task: { ...task, requiresApproval: approvalRequired },
    context,
    ...(blockedReason ? { blockedReason } : {}),
    approvalRequired,
    triggered,
  };
}
