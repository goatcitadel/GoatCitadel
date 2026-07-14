import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("journey API", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { protocol: "http:", hostname: "localhost", pathname: "/library/journey", search: "", hash: "" },
        localStorage: memoryStorage(),
        sessionStorage: memoryStorage(),
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => "journey-request" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("fetches the read-only timeline with encoded filters and cursor", async () => {
    const page = {
      schemaVersion: "goatcitadel.journey-timeline-page.v1",
      readOnly: true,
      mutationSemantics: "none",
      workspaceId: "workspace-1",
      includeGlobal: false,
      items: [],
      generatedAt: "2026-07-13T00:00:00.000Z",
    };
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fetchJourneyTimeline } = await import("./journey.js");

    const result = await fetchJourneyTimeline({
      workspaceId: "workspace-1",
      eventTypes: ["memory_lifecycle", "skill_learning_evidence_assessed"],
      poisoningStatuses: ["blocked", "conflicting"],
      sessionId: "session 1",
      cursor: "cursor/value",
      limit: 25,
    });

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/api/v1/journey/events");
    expect(url.searchParams.get("eventTypes")).toBe("memory_lifecycle,skill_learning_evidence_assessed");
    expect(url.searchParams.get("poisoningStatuses")).toBe("blocked,conflicting");
    expect(url.searchParams.get("sessionId")).toBe("session 1");
    expect(url.searchParams.get("cursor")).toBe("cursor/value");
    expect(result).toEqual(page);
  });
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}
