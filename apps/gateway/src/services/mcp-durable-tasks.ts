import type {
  DurableRunRecord,
  DurableRunStatus,
  McpInvokeRequest,
  McpInvokeResponse,
  McpServerRecord,
  McpToolRecord,
} from "@goatcitadel/contracts";
import { ValidationError } from "@goatcitadel/contracts";

export const MCP_DURABLE_TASKS_LIST_TOOL_NAME = "goatcitadel.durable.tasks.list";
export const MCP_DURABLE_TASKS_GET_TOOL_NAME = "goatcitadel.durable.tasks.get";
export const MCP_DURABLE_TASKS_CANCEL_TOOL_NAME = "goatcitadel.durable.tasks.cancel";
export const MCP_DURABLE_TASKS_URL = "goatcitadel://durable-tasks";

/** Safe, payload-free view of a durable run exposed as an MCP "task". */
export interface McpDurableTaskView {
  taskId: string;
  workflowKey: string;
  status: DurableRunStatus;
  attemptCount: number;
  maxAttempts: number;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpDurableTasksPort {
  listRuns: (limit?: number) => DurableRunRecord[];
  getRun: (runId: string) => DurableRunRecord | undefined;
  cancelRun: (runId: string) => DurableRunRecord;
}

interface McpDurableTaskScope {
  workspaceId: string;
}

export function isInternalMcpDurableTasksServer(server: Pick<McpServerRecord, "url">): boolean {
  return server.url?.trim().toLowerCase() === MCP_DURABLE_TASKS_URL;
}

export function toDurableTaskView(run: DurableRunRecord): McpDurableTaskView {
  return {
    taskId: run.runId,
    workflowKey: run.workflowKey,
    status: run.status,
    attemptCount: run.attemptCount,
    maxAttempts: run.maxAttempts,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    lastError: run.lastError,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export function createInternalMcpDurableTasksTools(serverId: string): McpToolRecord[] {
  const updatedAt = new Date().toISOString();
  return [
    {
      serverId,
      toolName: MCP_DURABLE_TASKS_LIST_TOOL_NAME,
      description: "Lists durable agent tasks (long-running async runs) with their status (MCP v2 Tasks).",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: { limit: { type: "number" } },
      },
    },
    {
      serverId,
      toolName: MCP_DURABLE_TASKS_GET_TOOL_NAME,
      description: "Gets a single durable agent task by id, including its status and last error.",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
    },
    {
      serverId,
      toolName: MCP_DURABLE_TASKS_CANCEL_TOOL_NAME,
      description: "Requests cancellation of a running durable agent task by id.",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
      },
    },
  ];
}

export async function handleInternalMcpDurableTasksInvoke(
  server: McpServerRecord,
  input: McpInvokeRequest,
  deps: McpDurableTasksPort,
): Promise<McpInvokeResponse> {
  if (!isInternalMcpDurableTasksServer(server)) {
    return { ok: false, error: `MCP server ${server.serverId} is not an internal durable-tasks server.` };
  }
  const scope = resolveDurableTaskScope(input);
  if (!scope) {
    return { ok: false, error: "Durable task MCP tools require a resolved workspace scope." };
  }
  try {
    switch (input.toolName) {
      case MCP_DURABLE_TASKS_LIST_TOOL_NAME: {
        const limit = parseLimit(input.arguments?.limit) ?? 50;
        const tasks = deps
          .listRuns(200)
          .filter((run) => durableRunMatchesScope(run, scope))
          .slice(0, limit)
          .map(toDurableTaskView);
        return { ok: true, output: { tasks } };
      }
      case MCP_DURABLE_TASKS_GET_TOOL_NAME: {
        const taskId = requireNonEmptyString(input.arguments?.taskId, "taskId");
        const run = deps.getRun(taskId);
        if (!run || !durableRunMatchesScope(run, scope)) {
          return { ok: false, error: `Durable task ${taskId} not found.` };
        }
        return { ok: true, output: { task: toDurableTaskView(run) } };
      }
      case MCP_DURABLE_TASKS_CANCEL_TOOL_NAME: {
        const taskId = requireNonEmptyString(input.arguments?.taskId, "taskId");
        const run = deps.getRun(taskId);
        if (!run || !durableRunMatchesScope(run, scope)) {
          return { ok: false, error: `Durable task ${taskId} not found.` };
        }
        return { ok: true, output: { task: toDurableTaskView(deps.cancelRun(taskId)) } };
      }
      default:
        return { ok: false, error: `Unsupported internal durable-tasks tool ${input.toolName}.` };
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function parseLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(200, Math.trunc(value)));
}

function resolveDurableTaskScope(input: McpInvokeRequest): McpDurableTaskScope | undefined {
  const workspaceId = input.workspaceId?.trim();
  return workspaceId ? { workspaceId } : undefined;
}

function durableRunMatchesScope(run: DurableRunRecord, scope: McpDurableTaskScope): boolean {
  return readDurableRunString(run, "workspaceId") === scope.workspaceId;
}

function readDurableRunString(run: DurableRunRecord, key: string): string | undefined {
  const direct = readRecordString(run.metadata, key) ?? readRecordString(run.payload, key);
  if (direct) {
    return direct;
  }
  const policyContext = readRecord(run.payload.policyContext) ?? readRecord(run.metadata?.policyContext);
  return readRecordString(policyContext, key);
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readRecordString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError({ message: `${field} is required.` });
  }
  return value.trim();
}
