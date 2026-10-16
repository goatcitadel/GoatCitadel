// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchChatSessions } from "@goatcitadel/mission-control-shared/api/chat";
import { fetchRealtimeEvents } from "@goatcitadel/mission-control-shared/api/system";
import { WorkHistory } from "./WorkHistory";

vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatSessions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => ({ fetchRealtimeEvents: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/hooks/useEventStreamStatus", () => ({
  useEventStreamStatus: () => ({ state: "open" }),
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("./WorkRunHistory", () => ({ WorkRunHistory: () => null }));
vi.mock("../../ui/NativeOwnerLink", () => ({
  NativeOwnerLink: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.clearAllMocks();
});

it("names each history link by its destination and row", async () => {
  vi.mocked(fetchChatSessions).mockResolvedValue({
    items: [
      { sessionId: "s-1", workspaceId: "workspace-a", title: "Release notes", updatedAt: "2026-10-01T10:00:00Z" },
      { sessionId: "s-2", workspaceId: "workspace-a", title: "Budget review", updatedAt: "2026-10-01T09:00:00Z" },
    ],
  } as never);
  vi.mocked(fetchRealtimeEvents).mockResolvedValue({
    items: [
      {
        eventId: "e-1",
        eventType: "durable.run.completed",
        source: "gateway",
        timestamp: "2026-10-01T11:00:00Z",
        payload: {},
        links: { workspaceId: "workspace-a", runId: "run-1" },
      },
    ],
  } as never);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <WorkHistory />
      </QueryClientProvider>,
    ),
  );
  await vi.waitFor(() => expect(container.textContent).toContain("Release notes"));
  const names = [...container.querySelectorAll("a")].map((link) => link.textContent);
  expect(names).toContain("Open conversation: Release notes");
  expect(names).toContain("Open conversation: Budget review");
  expect(names.find((name) => name?.startsWith("Open run: "))).toBeDefined();
  expect(new Set(names).size).toBe(names.length);
  expect(container.textContent).not.toContain("Open record");
  expect(container.textContent).not.toContain("signal");
});
