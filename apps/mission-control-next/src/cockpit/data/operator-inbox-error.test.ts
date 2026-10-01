import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { describeOperatorInboxError } from "./operator-inbox-error";

function missing(path: string, body?: unknown): ApiRequestError {
  return new ApiRequestError("API error 404", { kind: "http", method: "GET", path, status: 404, body });
}

describe("cockpit Inbox error copy", () => {
  it("explains an actual missing Inbox route while retaining the technical request", () => {
    const path = "/api/v1/inbox?workspaceId=default";
    const result = describeOperatorInboxError(
      missing(path, {
        statusCode: 404,
        error: "Not Found",
        message: `Route GET:${path} not found`,
      }),
    );
    expect(result.summary).toContain("matching versions");
    expect(result.summary).not.toContain("item no longer exists");
    expect(result.technical).toContain("GET /api/v1/inbox?workspaceId=default (404)");
  });

  it("keeps a missing workspace distinct from a missing endpoint", () => {
    const result = describeOperatorInboxError(
      missing("/api/v1/inbox?workspaceId=removed", {
        error: "Workspace not found.",
      }),
    );
    expect(result.summary).toContain("Choose another workspace");
    expect(result.summary).not.toContain("matching versions");
  });

  it("keeps ordinary missing-item and other failure descriptions", () => {
    expect(describeOperatorInboxError(missing("/api/v1/inbox/items/removed")).summary).toContain(
      "item no longer exists",
    );
    expect(describeOperatorInboxError(missing("/api/v1/inbox?workspaceId=default")).summary).toContain(
      "item no longer exists",
    );
    expect(
      describeOperatorInboxError(
        new ApiRequestError("API error 503", {
          kind: "http",
          method: "GET",
          path: "/api/v1/inbox?workspaceId=default",
          status: 503,
        }),
      ).summary,
    ).toContain("gateway hit an error");
  });
});
