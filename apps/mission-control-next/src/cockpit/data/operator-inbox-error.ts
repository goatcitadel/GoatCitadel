import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";

/** Keep a missing Inbox route distinct from a missing workspace or record. */
export function describeOperatorInboxError(error: unknown) {
  const description = describeApiError(error);
  if (
    !isApiRequestError(error) ||
    error.kind !== "http" ||
    error.status !== 404 ||
    error.method !== "GET" ||
    !/^\/api\/v1\/inbox(?:\?|$)/.test(error.path)
  ) {
    return description;
  }
  const body =
    error.body && typeof error.body === "object" ? (error.body as { message?: unknown; error?: unknown }) : null;
  if (body?.error === "Workspace not found.") {
    return {
      ...description,
      summary: "The selected workspace no longer exists. Choose another workspace and refresh.",
    };
  }
  if (body?.message !== `Route GET:${error.path} not found`) return description;
  return {
    ...description,
    summary:
      "The Gateway did not provide the Inbox endpoint. Check that Mission Control and Gateway are running matching versions, then try again.",
  };
}
