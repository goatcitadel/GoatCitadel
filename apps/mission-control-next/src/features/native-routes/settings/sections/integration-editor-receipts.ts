import { canonicalJsonString, SECRET_REDACTION_MARKER, type IntegrationConnection } from "@goatcitadel/contracts";
import { fetchIntegrationConnection, isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import { hasIntegrationConnectionBinding } from "../integration-connection-mutation";

/**
 * Whether a partly withheld reply acknowledges the submitted string: its echoed parts, in order, are the submitted
 * text with each marker standing for one withheld run (a credential query value or webhook path segment, say).
 */
function echoedPartsMatch(submitted: string, saved: string): boolean {
  const parts = saved.split(SECRET_REDACTION_MARKER);
  const head = parts[0] ?? "",
    tail = parts.at(-1) ?? "";
  const end = submitted.length - tail.length;
  if (end < head.length || !submitted.startsWith(head) || !submitted.endsWith(tail)) return false;
  let cursor = head.length;
  for (const part of parts.slice(1, -1)) {
    const found = submitted.indexOf(part, cursor);
    if (found < 0 || found + part.length > end) return false;
    cursor = found + part.length;
  }
  return true;
}

/** Compare public values; a canonical redaction confirms custody, never the underlying credential value. */
export function integrationPublicConfigMatches(submitted: unknown, saved: unknown): boolean {
  if (saved === SECRET_REDACTION_MARKER) return true;
  if (typeof submitted === "string" && typeof saved === "string" && saved.includes(SECRET_REDACTION_MARKER))
    return echoedPartsMatch(submitted, saved);
  if (Array.isArray(submitted))
    return (
      Array.isArray(saved) &&
      submitted.length === saved.length &&
      submitted.every((item, index) => integrationPublicConfigMatches(item, saved[index]))
    );
  if (submitted && typeof submitted === "object")
    return Boolean(
      saved &&
      typeof saved === "object" &&
      !Array.isArray(saved) &&
      Object.entries(submitted).every(([key, value]) =>
        integrationPublicConfigMatches(value, (saved as Record<string, unknown>)[key]),
      ),
    );
  return Object.is(submitted, saved);
}
export async function verifyIntegrationReadback(receipt: IntegrationConnection) {
  if (!hasIntegrationConnectionBinding(receipt)) throw new Error("The Gateway did not acknowledge a bound connection.");
  const saved = await fetchIntegrationConnection(receipt.connectionId);
  if (canonicalJsonString(saved) !== canonicalJsonString(receipt))
    throw new Error("The saved connection does not match its Gateway acknowledgement.");
}
export async function verifyIntegrationDeleted(connectionId: string, receipt: { deleted: boolean }) {
  if (receipt.deleted !== true) throw new Error("The Gateway did not confirm deletion.");
  try {
    await fetchIntegrationConnection(connectionId);
  } catch (error) {
    if (
      isApiRequestError(error) &&
      error.method === "GET" &&
      error.path === `/api/v1/integrations/connections/${encodeURIComponent(connectionId)}` &&
      error.status === 404 &&
      (error.body as { code?: string } | undefined)?.code === "ENTITY_NOT_FOUND"
    )
      return;
    throw error;
  }
  throw new Error("The deleted connection is still present in the owner readback.");
}
