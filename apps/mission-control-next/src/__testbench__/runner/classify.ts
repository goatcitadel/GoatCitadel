import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { CheckAssertionError } from "./assert";

export interface Classification {
  readonly status: "fail" | "blocked" | "cancelled" | "unreachable";
  readonly summary: string;
  readonly evidence?: unknown;
}

export function classifyError(error: unknown): Classification {
  if (hasName(error, "AbortError")) {
    return { status: "cancelled", summary: "Stopped before it finished." };
  }
  if (hasName(error, "TimeoutError")) {
    return { status: "fail", summary: "Timed out before it finished." };
  }
  if (error instanceof CheckAssertionError) {
    return { status: "fail", summary: error.message, evidence: error.evidence };
  }
  if (!isApiRequestError(error)) {
    return { status: "fail", summary: error instanceof Error ? error.message : String(error) };
  }
  if (error.kind === "network") {
    return { status: "unreachable", summary: `Gateway unreachable: ${error.message}` };
  }
  if (error.kind === "protocol") {
    return {
      status: "fail",
      summary: `Malformed response from ${error.method} ${error.path}.`,
      evidence: error.bodyText,
    };
  }
  return classifyHttpError(
    error.status ?? 0,
    readErrorMessage(error.body, error.bodyText),
    error.body ?? error.bodyText,
    `${error.method} ${error.path}`,
  );
}

function classifyHttpError(status: number, message: string, evidence: unknown, where: string): Classification {
  const blocked = (summary: string): Classification => ({ status: "blocked", summary, evidence });
  if (status === 404 && /disabled/i.test(message)) {
    return blocked(`Disabled on this gateway: ${message}`);
  }
  if (status === 409 && isFeatureFlagConflict(evidence)) {
    return blocked(`A feature flag is off: ${message}`);
  }
  if (status === 400 && /is disabled/i.test(message)) {
    return blocked(`Disabled on this gateway: ${message}`);
  }
  if (status === 401 || status === 403) {
    return blocked(`Access refused (${status}): ${message}`);
  }
  if (status === 503) {
    return blocked(`Unavailable (503): ${message}`);
  }
  return { status: "fail", summary: `${where} returned ${status}: ${message}`, evidence };
}

export function readErrorMessage(body: unknown, bodyText: string | undefined): string {
  if (isRecord(body)) {
    if (typeof body.error === "string" && body.error.trim() !== "") {
      return body.error;
    }
    if (isRecord(body.error)) {
      const parts = [body.error.code, body.error.reason].filter(
        (part): part is string => typeof part === "string" && part !== "",
      );
      if (parts.length > 0) {
        return parts.join(": ");
      }
    }
    if (typeof body.message === "string" && body.message.trim() !== "") {
      return body.message;
    }
  }
  const text = bodyText?.trim();
  return text ? text : "No error message.";
}

function isFeatureFlagConflict(body: unknown): boolean {
  return (
    isRecord(body) && body.code === "STATE_CONFLICT" && isRecord(body.details) && typeof body.details.flag === "string"
  );
}

function hasName(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
