import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { COCKPIT_STALE_TIME_MS, createCockpitQueryClient, shouldRetryQuery } from "./query-client";
import { queryKeys } from "./query-keys";

describe("cockpit query client", () => {
  it("does not retry client errors and bounds transport retries", () => {
    const notFound = new ApiRequestError("API error 404", { kind: "http", method: "GET", path: "/x", status: 404 });
    const offline = new ApiRequestError("Network error", { kind: "network", method: "GET", path: "/x" });
    expect(shouldRetryQuery(0, notFound)).toBe(false);
    expect(shouldRetryQuery(0, offline)).toBe(true);
    expect(shouldRetryQuery(2, offline)).toBe(false);
  });

  it("uses thirty-second staleness and topic-prefixed keys", () => {
    expect(createCockpitQueryClient().getDefaultOptions().queries?.staleTime).toBe(COCKPIT_STALE_TIME_MS);
    expect(queryKeys.workspaces("c-1")[0]).toBe("system");
    expect(queryKeys.citadels()[0]).toBe("system");
    expect(queryKeys.capabilities()[0]).toBe("skills");
  });
});
