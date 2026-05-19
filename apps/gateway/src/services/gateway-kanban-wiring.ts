import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { fetchAllowlisted } from "@goatcitadel/policy-engine";
import type { ArtifactProbers } from "./task-artifact-verifier.js";
import type { TaskLifecycleService } from "./task-lifecycle-service.js";

const execFileAsync = promisify(execFile);
const DEFAULT_ARTIFACT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_ARTIFACT_GIT_TIMEOUT_MS = 5_000;

export interface DefaultArtifactProberOptions {
  fileReadRoots?: string[];
  networkAllowlist?: string[];
  maxConcurrency?: number;
  httpTimeoutMs?: number;
  gitTimeoutMs?: number;
}

export function createDefaultArtifactProbers(options: DefaultArtifactProberOptions = {}): ArtifactProbers {
  const networkAllowlist = normalizeList(options.networkAllowlist) ?? [];
  return {
    fileReadRoots: normalizeList(options.fileReadRoots) ?? [process.cwd()],
    networkAllowlist,
    maxConcurrency: options.maxConcurrency,
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
          const response = await fetchAllowlisted(url, {
            allowlist: networkAllowlist,
            timeoutMs: Math.max(1, options.httpTimeoutMs ?? DEFAULT_ARTIFACT_HTTP_TIMEOUT_MS),
            init: { method: "HEAD" },
          });
          return response.ok;
        } catch (error) {
          if (isPolicyBlockError(error)) {
            throw error;
          }
          return false;
        }
      },
    },
    git: {
      hasCommit: async (sha: string) => {
        try {
          await execFileAsync("git", ["cat-file", "-e", sha], {
            timeout: Math.max(1, options.gitTimeoutMs ?? DEFAULT_ARTIFACT_GIT_TIMEOUT_MS),
            windowsHide: true,
          });
          return true;
        } catch {
          return false;
        }
      },
    },
  };
}

function isPolicyBlockError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /blocked|allowlisted/i.test(error.message);
}

function normalizeList(values: string[] | undefined): string[] | undefined {
  if (!values) {
    return undefined;
  }
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function createDurableTaskAutoBlockBridge(lifecycle: TaskLifecycleService) {
  return {
    autoBlockOnIncompleteExit: (taskId: string, runId: string) => lifecycle.autoBlockOnIncompleteExit(taskId, runId),
  };
}
