import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { appendRetainedActivity } from "./activity-feed";
import { queryKeys } from "./query-keys";

const ev = (id: string) => ({
  eventId: id,
  sequence: 1,
  eventType: "chat_message",
  source: "chat",
  timestamp: "2026-10-05T10:00:00.000Z",
  payload: {},
});

describe("appendRetainedActivity", () => {
  it("prepends, dedupes and caps at 100", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.systemActivity(), { items: Array.from({ length: 100 }, (_, i) => ev(`old-${i}`)) });
    appendRetainedActivity(client, ev("new"));
    appendRetainedActivity(client, ev("new"));
    const data = client.getQueryData<{ items: { eventId: string }[] }>(queryKeys.systemActivity());
    expect(data?.items[0]?.eventId).toBe("new");
    expect(data?.items).toHaveLength(100);
    expect(data?.items.filter((item) => item.eventId === "new")).toHaveLength(1);
  });

  it("does nothing before the first read", () => {
    const client = new QueryClient();
    appendRetainedActivity(client, ev("new"));
    expect(client.getQueryData(queryKeys.systemActivity())).toBeUndefined();
  });

  it("extends every cached Work activity read under a prefix", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.workActivity("ws-1"), { items: [ev("a")] });
    client.setQueryData(queryKeys.workActivity("ws-2"), { items: [ev("b")] });
    appendRetainedActivity(client, ev("new"), queryKeys.workActivityAll());
    expect(
      client.getQueryData<{ items: { eventId: string }[] }>(queryKeys.workActivity("ws-1"))?.items[0]?.eventId,
    ).toBe("new");
    expect(
      client.getQueryData<{ items: { eventId: string }[] }>(queryKeys.workActivity("ws-2"))?.items[0]?.eventId,
    ).toBe("new");
  });
});
