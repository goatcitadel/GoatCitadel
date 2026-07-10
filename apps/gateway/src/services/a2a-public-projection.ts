import type { A2ABridgeMessage, A2ABridgeTask, A2ABridgeTaskEvent, A2AJsonRpcResponse } from "@goatcitadel/contracts";
import { projectPublicSecretValue } from "./public-secret-projection.js";

/**
 * Builds a detached A2A external-boundary projection. Canonical Gateway
 * projection owns local artifacts, metadata, URLs, and errors. Authored A2A
 * messages retain their protocol shape and content because they are peer/user
 * input being carried back to that peer, not locally generated evidence.
 */
export function projectA2AExternalValue<T>(value: T): T {
  return restoreAuthoredMessages(value, projectPublicSecretValue(value), "root") as T;
}

export function projectA2ATaskForExternal(task: A2ABridgeTask): A2ABridgeTask {
  return projectA2AExternalValue(task);
}

export function projectA2ATaskEventForExternal(event: A2ABridgeTaskEvent): A2ABridgeTaskEvent {
  return projectA2AExternalValue(event);
}

export function projectA2AJsonRpcResponseForExternal(response: A2AJsonRpcResponse): A2AJsonRpcResponse {
  return projectA2AExternalValue(response);
}

export function projectA2AExternalErrorText(message: string): string {
  const projected = projectPublicSecretValue({ errorText: message }).errorText;
  return isSafeA2AAuthStatusText(message) ? message : projected;
}

type ProjectionContext = "root" | "generic" | "task_messages" | "authored_message" | "a2a_params";

function restoreAuthoredMessages(raw: unknown, projected: unknown, context: ProjectionContext): unknown {
  if (context === "authored_message" && isA2ABridgeMessage(raw)) {
    return structuredClone(raw);
  }
  if (Array.isArray(raw) && Array.isArray(projected)) {
    const itemContext = context === "task_messages" ? "authored_message" : "generic";
    return raw.map((item, index) => restoreAuthoredMessages(item, projected[index], itemContext));
  }
  if (!isRecord(raw) || !isRecord(projected)) {
    return projected;
  }
  const task = isA2ABridgeTask(raw);
  const messageEvent = raw.kind === "task.message";
  const jsonRpcEnvelope = context === "root" && raw.jsonrpc === "2.0" && typeof raw.method === "string";
  return Object.fromEntries(
    Object.entries(projected).map(([key, child]) => [
      key,
      restoreAuthoredMessages(
        raw[key],
        child,
        task && key === "messages"
          ? "task_messages"
          : messageEvent && key === "message"
            ? "authored_message"
            : jsonRpcEnvelope && key === "params"
              ? "a2a_params"
              : context === "a2a_params" && key === "message"
                ? "authored_message"
                : "generic",
      ),
    ]),
  );
}

function isA2ABridgeMessage(value: unknown): value is A2ABridgeMessage {
  return isRecord(value) && (value.role === "user" || value.role === "agent") && Array.isArray(value.parts);
}

function isA2ABridgeTask(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    typeof value.contextId === "string" &&
    isRecord(value.status) &&
    Array.isArray(value.messages) &&
    Array.isArray(value.artifacts)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeA2AAuthStatusText(value: string): boolean {
  return (
    value === "A2A peer bearer credentials are required." ||
    value === "A2A peer credentials are unknown, expired, revoked, or missing their configured secret."
  );
}
