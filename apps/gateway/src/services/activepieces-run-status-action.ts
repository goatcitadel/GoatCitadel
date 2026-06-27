import type {
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import type { IntegrationActionHost } from "./integration-action-service.js";

const ACTION_ID = "check_run_status";

export async function invokeActivepiecesRunStatusAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const workflowRunId =
    readStringInput(request.input, "workflowRunId") ??
    readStringInput(request.input, "flowRunId") ??
    readStringInput(request.input, "runId");
  if (!workflowRunId) {
    return blocked(
      connection,
      checkedAt,
      "Enter the Activepieces flow-run id returned by a webhook response before checking status.",
      "activepieces_run_id_missing",
    );
  }
  const apiBaseUrl = host.readConnectionConfigValue(connection.config, "apiBaseUrl");
  if (!apiBaseUrl) {
    return blocked(
      connection,
      checkedAt,
      "Configure an Activepieces API base URL before checking run status.",
      "activepieces_api_base_url_missing",
    );
  }
  const apiToken = host.resolveConnectionSecret(connection.config, "apiToken", "apiTokenEnv");
  if (!apiToken) {
    return blocked(
      connection,
      checkedAt,
      "Configure an Activepieces API token ENV var before checking run status.",
      "activepieces_api_token_missing",
    );
  }

  let target: string;
  try {
    target = buildActivepiecesFlowRunStatusUrl(apiBaseUrl, workflowRunId);
  } catch (error) {
    return blocked(
      connection,
      checkedAt,
      error instanceof Error ? error.message : "Activepieces API base URL is invalid.",
      "activepieces_api_base_url_invalid",
    );
  }

  const response = await host.fetchWithDiagnosticsTimeout(target, {
    method: "GET",
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: "application/json",
    },
  });
  const parsed = await parseResponse(response);
  if (!response.ok) {
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId: ACTION_ID,
      status: "failed",
      message: parsed.message ?? `Activepieces run status check failed (${response.status}).`,
      output: {
        provider: "activepieces",
        workflowRunId,
        workflowRunStatusSource: "activepieces_api",
      },
      checkedAt,
    };
  }

  const run = normalizeProviderOutput(parsed.output);
  const workflowRunStatus = readFirstString(run, ["status", "workflowRunStatus", "flowRunStatus"]);
  const workflowRunUrl = sanitizeReturnedWorkflowUrl(readFirstString(run, ["url", "webUrl", "workflowRunUrl"]));
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId: ACTION_ID,
    status: "executed",
    message: workflowRunStatus
      ? `Fetched Activepieces flow-run status: ${workflowRunStatus}.`
      : "Fetched Activepieces flow-run status evidence.",
    output: {
      provider: "activepieces",
      workflowRunId,
      ...(workflowRunStatus ? { workflowRunStatus } : {}),
      ...(workflowRunUrl ? { workflowRunUrl } : {}),
      workflowRunStatusSource: "activepieces_api",
      checkedEndpoint: "/api/v1/flow-runs/{id}",
      checkedAt,
    },
    checkedAt,
  };
}

function blocked(
  connection: IntegrationConnection,
  checkedAt: string,
  message: string,
  blockedReason: string,
): IntegrationActionInvokeResult {
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId: ACTION_ID,
    status: "blocked",
    message,
    blockedReason,
    checkedAt,
  };
}

function buildActivepiecesFlowRunStatusUrl(apiBaseUrl: string, workflowRunId: string): string {
  const base = parseHttpUrl(apiBaseUrl);
  const url = new URL(joinUrl(base, `/api/v1/flow-runs/${encodeURIComponent(workflowRunId)}`));
  return url.toString();
}

async function parseResponse(
  response: Response,
): Promise<{ message?: string; output?: Record<string, unknown> | unknown[] | string }> {
  const raw = await readBoundedResponseText(response, {
    maxBytes: 128 * 1024,
    timeoutMs: 5_000,
    label: "Activepieces run status",
  });
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return {
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        output: parsed,
      };
    }
    if (Array.isArray(parsed) || typeof parsed === "string") {
      return { output: parsed };
    }
  } catch {
    return { output: raw.trim() };
  }
  return { output: raw.trim() };
}

function normalizeProviderOutput(
  output: Record<string, unknown> | unknown[] | string | undefined,
): Record<string, unknown> {
  if (isRecord(output)) {
    return output;
  }
  return output === undefined ? {} : { raw: output };
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readStringInput(input: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!input) {
    return undefined;
  }
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeReturnedWorkflowUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function parseHttpUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return parsed.toString();
  } catch {
    throw new Error("Activepieces API base URL must be an http or https URL.");
  }
}

function joinUrl(baseUrl: string, suffix: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${normalizedBase}${normalizedSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
