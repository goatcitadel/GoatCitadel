import { describe, expect, it } from "vitest";
import type { DevDiagnosticsEvent } from "@goatcitadel/contracts";
import { buildRecentDiagnosticsExport } from "./recent-diagnostics-export";

describe("recent diagnostics export", () => {
  it("keeps partial source truth and excludes event context that the page does not show", () => {
    const event = {
      id: "event-1",
      timestamp: "2026-09-28T01:00:00.000Z",
      level: "warn",
      category: "api",
      event: "request_failed",
      message: "Request failed",
      source: "gateway",
      context: { credential: "hidden-context-value" },
    } satisfies DevDiagnosticsEvent;
    const result = buildRecentDiagnosticsExport({
      generatedAt: "2026-09-28T02:00:00.000Z",
      events: {
        items: Array.from({ length: 101 }, (_, index) => ({ ...event, id: `event-${index}` })),
        failed: false,
        fetchedAt: Date.parse("2026-09-28T01:30:00.000Z"),
      },
      logs: { failed: true, fetchedAt: 0 },
    });
    expect(result.sourceStatus).toEqual({
      diagnosticEvents: { state: "available", fetchedAt: "2026-09-28T01:30:00.000Z" },
      daemonLogs: { state: "unavailable" },
    });
    expect(result.daemonLogs).toBeNull();
    expect(result.diagnosticEvents).toHaveLength(100);
    expect(result.diagnosticEvents?.[0]).toEqual({
      id: "event-0",
      timestamp: event.timestamp,
      level: event.level,
      category: event.category,
      event: event.event,
      message: event.message,
      source: event.source,
    });
    expect(JSON.stringify(result)).not.toContain("hidden-context-value");
  });
});
