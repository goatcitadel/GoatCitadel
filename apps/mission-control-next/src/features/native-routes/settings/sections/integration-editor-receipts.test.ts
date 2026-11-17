import { afterEach, describe, expect, it, vi } from "vitest";
import { redactStructuredSecrets, type IntegrationConnection } from "@goatcitadel/contracts";
import { fetchIntegrationConnection } from "@goatcitadel/mission-control-shared/api/integrations-operations";
import {
  integrationPublicConfigMatches,
  verifyIntegrationDeleted,
  verifyIntegrationReadback,
} from "./integration-editor-receipts";

describe("integration receipt readback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["update", "deletion"])("verifies a committed %s while an older GET is in flight", async (action) => {
    const before: IntegrationConnection = {
      connectionId: "fixture/channel",
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Fixture channel",
      enabled: true,
      status: "connected",
      config: {},
      revision: "a".repeat(64),
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    const saved = { ...before, enabled: false, revision: "b".repeat(64) };
    const after =
      action === "update" ? Response.json(saved) : Response.json({ code: "ENTITY_NOT_FOUND" }, { status: 404 });
    let finishOlder!: (response: Response) => void;
    const olderResponse = new Promise<Response>((resolve) => {
      finishOlder = resolve;
    });
    const fetchMock = vi.fn().mockReturnValueOnce(olderResponse).mockResolvedValueOnce(after);
    vi.stubGlobal("fetch", fetchMock);

    const background = fetchIntegrationConnection(before.connectionId);
    expect(fetchMock).toHaveBeenCalledOnce();
    const confirmation =
      action === "update"
        ? verifyIntegrationReadback(saved)
        : verifyIntegrationDeleted(before.connectionId, { deleted: true });
    const settled = Promise.allSettled([background, confirmation]);
    const readsBeforeOlderResponse = fetchMock.mock.calls.length;
    finishOlder(Response.json(before));

    expect(await settled).toEqual([
      { status: "fulfilled", value: before },
      { status: "fulfilled", value: undefined },
    ]);
    expect(readsBeforeOlderResponse).toBe(2);
  });
});

/** The canonical structured redactor the Gateway's public projection starts from. */
function project<T>(value: T): T {
  return redactStructuredSecrets(value, { redactEnvAssignmentsAsWhole: true }).value;
}

describe("integrationPublicConfigMatches", () => {
  it("accepts a whole-value redaction, whatever was submitted", () => {
    expect(integrationPublicConfigMatches("abc.def-ghi.jkl1234567890", "[REDACTED]")).toBe(true);
    expect(integrationPublicConfigMatches("", "[REDACTED]")).toBe(true);
  });

  it("accepts a URL whose credential query value the projection withholds", () => {
    const submitted = {
      serverUrl: "https://chat.example.com/?token=abc",
      baseUrl: "https://chat.example.com/api?token=abc&team=ops",
    };
    const saved = project(submitted);
    expect(saved.serverUrl).toBe("https://chat.example.com/?token=[REDACTED]");
    expect(saved.baseUrl).toBe("https://chat.example.com/api?token=[REDACTED]&team=ops");
    expect(integrationPublicConfigMatches(submitted, saved)).toBe(true);
  });

  it("accepts withheld webhook path segments, one marker per withheld run", () => {
    // The Gateway's credential-URL projection (apps/gateway/src/services/public-secret-projection.ts) withholds the
    // segments after a /webhook/ label; the contracts redactor leaves this path alone, so the reply is written out.
    expect(
      integrationPublicConfigMatches(
        "https://chat.example.com/webhook/abc123/def456",
        "https://chat.example.com/webhook/[REDACTED]/[REDACTED]",
      ),
    ).toBe(true);
    expect(
      integrationPublicConfigMatches("https://chat.example.com/?token=", "https://chat.example.com/?token=[REDACTED]"),
    ).toBe(true);
  });

  it("rejects a partly withheld reply whose echoed parts differ from the submitted value", () => {
    const submitted = "https://chat.example.com/?token=abc&team=ops";
    expect(integrationPublicConfigMatches(submitted, "https://chat.other.example/?token=[REDACTED]&team=ops")).toBe(
      false,
    );
    expect(integrationPublicConfigMatches(submitted, "https://chat.example.com/?token=[REDACTED]&team=dev")).toBe(
      false,
    );
    expect(
      integrationPublicConfigMatches(
        "https://chat.example.com/?token=abc",
        "https://chat.example.com/?token=[REDACTED]&team=ops",
      ),
    ).toBe(false);
    expect(
      integrationPublicConfigMatches(
        "https://chat.example.com/webhook/abc123",
        "https://chat.example.com/webhook/[REDACTED]/[REDACTED]",
      ),
    ).toBe(false);
  });

  it("never lets the echoed prefix and suffix overlap, or reorder the echoed parts", () => {
    expect(integrationPublicConfigMatches("ab", "ab[REDACTED]b")).toBe(false);
    expect(integrationPublicConfigMatches("abc", "a[REDACTED]x[REDACTED]c")).toBe(false);
    expect(integrationPublicConfigMatches("a-y-x-c", "a[REDACTED]x[REDACTED]y[REDACTED]c")).toBe(false);
    expect(integrationPublicConfigMatches("a-x-y-c", "a[REDACTED]x[REDACTED]y[REDACTED]c")).toBe(true);
  });

  it("keeps a partial marker from acknowledging a value that was not a string", () => {
    expect(integrationPublicConfigMatches(42, "4[REDACTED]")).toBe(false);
    expect(integrationPublicConfigMatches({ url: "x" }, "x[REDACTED]")).toBe(false);
  });
});
