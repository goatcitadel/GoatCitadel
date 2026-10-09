// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@goatcitadel/contracts";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { RecentSessions } from "./RecentSessions";

const api = vi.hoisted(() => ({ fetchSessions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/sessions", () => api);

const session = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId: "sess_abc123",
  sessionKey: "key",
  kind: "dm",
  channel: "telegram",
  account: "acct",
  lastActivityAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z",
  health: "healthy",
  tokenInput: 10,
  tokenOutput: 20,
  tokenCachedInput: 0,
  tokenTotal: 30,
  costUsdTotal: 0.0123,
  budgetState: "ok",
  ...overrides,
});
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const render = () =>
  act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <RecentSessions />
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("cockpit recent sessions", () => {
  it("lists sessions across channels with health, budget and a native Chat link", async () => {
    api.fetchSessions.mockResolvedValue({
      items: [
        session({ displayName: "Support line" }),
        session({ sessionId: "sess_def456", channel: "slack", health: "blocked", budgetState: "hard_cap" }),
      ],
    });
    await render();
    await settle();
    const list = container.querySelector('[aria-label="Recent sessions"]')!;
    const rows = list.querySelectorAll(":scope > li");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Support line");
    expect(rows[0]!.textContent).toContain("Telegram");
    expect(rows[0]!.textContent).toContain("Healthy");
    expect(rows[1]!.textContent).toContain("Slack");
    expect(rows[1]!.textContent).toContain("Blocked");
    expect(rows[1]!.textContent).toContain("Budget: hard cap reached");
    const link = rows[0]!.querySelector("a");
    expect(link?.textContent).toBe("Open in Chat");
    expect(link?.getAttribute("href")).toContain("/chat?sessionId=sess_abc123");
  });

  it("keeps identifiers and usage inside technical details", async () => {
    api.fetchSessions.mockResolvedValue({ items: [session()] });
    await render();
    await settle();
    const details = container.querySelector("details")!;
    expect(details.querySelector("summary")?.textContent).toBe("Session details");
    expect(details.textContent).toContain("sess_abc123");
    expect(details.textContent).toContain("30 tokens");
  });

  it("says when there are no sessions and when the list is unavailable", async () => {
    api.fetchSessions.mockResolvedValueOnce({ items: [] });
    await render();
    await settle();
    expect(container.textContent).toContain("No sessions have recent activity.");
    api.fetchSessions.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      [...container.querySelectorAll("button")].find((item) => item.textContent === "Refresh sessions")!.click();
    });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Sessions unavailable");
  });
});
