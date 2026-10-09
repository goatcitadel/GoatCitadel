import type { BrowserSessionEventType } from "@goatcitadel/contracts";
import type { BrowserSessionRuntimeDependencies } from "./browser-session-runtime-service.js";

/**
 * Request-ID replay for browser sessions and grants. A create carries an optional request ID; the row and the event
 * that records the ID commit in one transaction, so a retried request after a lost response finds what it created
 * instead of creating a second session or grant.
 */
type BrowserSessionReplayStore = Pick<BrowserSessionRuntimeDependencies, "gatewaySql">;

/** Runs the callback in one immediate transaction, so a row and its request-ID event commit together. */
export async function runBrowserSessionTransaction<T>(
  deps: BrowserSessionReplayStore,
  callback: () => Promise<T>,
): Promise<T> {
  return (await deps.gatewaySql.runImmediateTransaction(callback)) as T;
}

/** The session an earlier create with this request ID produced, if any. */
export async function findSessionCreatedByRequestId(
  deps: BrowserSessionReplayStore,
  requestId: string,
): Promise<string | undefined> {
  // The bounded LIKE narrows candidates; the parsed payload is the authority.
  const rows = (await deps.gatewaySql
    .prepare(
      `
      SELECT session_id, payload_json
      FROM browser_session_events
      WHERE event_type = 'session_created' AND payload_json LIKE @pattern
      ORDER BY created_at DESC
      LIMIT 20
    `,
    )
    .all({ pattern: `%${requestId}%` })) as Array<{ session_id: string; payload_json: string }>;
  return rows.find((row) => parsePayload(row.payload_json).requestId === requestId)?.session_id;
}

/** The newest event of this type whose payload field equals the value, with a string grant ID. */
export async function findBrowserSessionEventPayload(
  deps: BrowserSessionReplayStore,
  sessionId: string,
  eventType: BrowserSessionEventType,
  field: "requestId" | "previousGrantId",
  value: string,
): Promise<Record<string, unknown> | undefined> {
  const rows = (await deps.gatewaySql
    .prepare(
      `
      SELECT payload_json
      FROM browser_session_events
      WHERE session_id = @sessionId AND event_type = @eventType
      ORDER BY created_at DESC
    `,
    )
    .all({ sessionId, eventType })) as Array<{ payload_json: string }>;
  for (const row of rows) {
    const payload = parsePayload(row.payload_json);
    if (payload[field] === value && typeof payload.grantId === "string") {
      return payload;
    }
  }
  return undefined;
}

function parsePayload(raw: string | undefined): Record<string, unknown> {
  try {
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
