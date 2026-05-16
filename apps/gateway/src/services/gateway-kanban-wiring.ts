import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import type { ArtifactProbers } from "./task-artifact-verifier.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";

export function createDefaultArtifactProbers(): ArtifactProbers {
  return {
    fs: {
      statExists: async (filePath: string) => {
        try {
          await fs.stat(filePath);
          return true;
        } catch {
          return false;
        }
      },
    },
    http: {
      headOk: async (url: string) => {
        try {
          const response = await fetch(url, { method: "HEAD" });
          return response.ok;
        } catch {
          return false;
        }
      },
    },
    git: {
      hasCommit: async (sha: string) => {
        try {
          execFileSync("git", ["cat-file", "-e", sha], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}

export function createDurableTaskAutoBlockBridge(lifecycle: TaskLifecycleService) {
  return {
    autoBlockOnIncompleteExit: (taskId: string, runId: string) => lifecycle.autoBlockOnIncompleteExit(taskId, runId),
  };
}
