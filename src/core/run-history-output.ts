import type { RunRecord } from "./orchestrator.js";

export interface RunHistoryJsonItem {
  id: string;
  goal: string;
  status: RunRecord["status"];
  createdAt: string;
  updatedAt: string;
  taskCount: number;
  pendingTaskCount: number;
  awaitingApprovalTaskCount: number;
  runningTaskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  blockedTaskCount: number;
  eventCount: number;
}

export interface RunHistoryJson {
  schemaVersion: 1;
  runs: RunHistoryJsonItem[];
}

/** Formats the public, versioned summary contract for `forge runs --json`. */
export function formatRunHistoryJson(runs: readonly RunRecord[]): string {
  const output: RunHistoryJson = {
    schemaVersion: 1,
    runs: runs.map((run) => ({
      id: run.id,
      goal: run.goal,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      taskCount: run.tasks.length,
      ...run.tasks.reduce((counts, task) => {
        switch (task.status) {
          case "pending": counts.pendingTaskCount += 1; break;
          case "awaiting_approval": counts.awaitingApprovalTaskCount += 1; break;
          case "running": counts.runningTaskCount += 1; break;
          case "completed": counts.completedTaskCount += 1; break;
          case "failed": counts.failedTaskCount += 1; break;
          case "blocked": counts.blockedTaskCount += 1; break;
          default: {
            const exhaustiveStatus: never = task.status;
            throw new Error(`Unsupported task status: ${String(exhaustiveStatus)}`);
          }
        }
        return counts;
      }, {
        pendingTaskCount: 0,
        awaitingApprovalTaskCount: 0,
        runningTaskCount: 0,
        completedTaskCount: 0,
        failedTaskCount: 0,
        blockedTaskCount: 0,
      }),
      eventCount: run.events.length,
    })),
  };
  return JSON.stringify(output, null, 2) + "\n";
}
