// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { McpServerRecord, McpServerTestEvidence } from "@goatcitadel/contracts";
import { McpSetupProgress } from "./McpSetupProgress";

const actions = vi.hoisted(() => ({ navigate: vi.fn(), copy: vi.fn() }));
vi.mock("../../app/use-cockpit-route", () => ({ useCockpitRoute: () => ({ navigate: actions.navigate }) }));
const server = {
  serverId: "server-a",
  label: "Fixture",
  revision: "revision-1",
  enabled: true,
  status: "connected",
} as McpServerRecord;
const tested: McpServerTestEvidence = {
  serverId: "server-a",
  workspaceId: "workspace",
  observedAt: "2026-10-11T00:00:00Z",
  state: "verified",
  historyLimit: 32,
  toolLimitPerTurn: 32,
  schemaSource: "cached_inventory",
  serverRevision: "revision-1",
  receipt: {
    sessionId: "session",
    turnId: "turn",
    durableRunId: "run",
    toolRunId: "tool",
    toolName: "mcp.server-a.read",
    approvalId: "approval",
    effectRunId: "effect",
    finishedAt: "2026-10-11T00:00:00Z",
    chatHref: "/chat?sessionId=session&turnId=turn",
  },
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  actions.navigate.mockReset();
  actions.copy.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: actions.copy } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const button = (name: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === name)!;

it("links only current verified approved receipts and labels changed generations or bounded misses truthfully", async () => {
  await act(async () => root.render(<McpSetupProgress server={server} stale={false} testEvidence={tested} />));
  expect(container.textContent).toContain("completed, approved Chat tool result");
  expect(container.textContent).toContain("cached tool schema");
  await act(async () => button("View tested Chat turn").click());
  expect(actions.navigate).toHaveBeenCalledWith(tested.receipt!.chatHref);
  await act(async () =>
    root.render(
      <McpSetupProgress server={{ ...server, connectionRevision: "changed" }} stale={false} testEvidence={tested} />,
    ),
  );
  expect(container.textContent).toContain("test evidence is stale");
  expect(button("View tested Chat turn")).toBeUndefined();
  await act(async () =>
    root.render(
      <McpSetupProgress
        server={server}
        stale={false}
        testEvidence={{ ...tested, state: "unverified", receipt: undefined }}
      />,
    ),
  );
  expect(container.textContent).toContain("latest 32 workspace runs");
  expect(container.textContent).toContain("Older or other kinds of tests may exist");
  await act(async () =>
    root.render(
      <McpSetupProgress
        server={server}
        stale={false}
        testEvidence={{ ...tested, state: "unavailable", receipt: undefined }}
      />,
    ),
  );
  expect(container.textContent).toContain("test evidence is unavailable");
});

it("separates retained setup evidence from callability and tested outcomes without running a tool", async () => {
  await act(async () => root.render(<McpSetupProgress server={server} tools={[]} stale={false} />));
  expect(container.textContent).toContain("Saved:");
  expect(container.textContent).toContain("Last recorded state is connected");
  expect(container.textContent).toContain("0 cached tool descriptors");
  expect(container.textContent).toContain("does not establish callability");
  expect(container.textContent).toContain("No task result is verified");
  expect(actions.copy).not.toHaveBeenCalled();
  expect(actions.navigate).not.toHaveBeenCalled();
  await act(async () => button("Copy sample task").click());
  expect(actions.copy).toHaveBeenCalledWith(expect.stringContaining('MCP server "server-a"'));
  expect(actions.copy).toHaveBeenCalledWith(expect.stringContaining("normal approval flow"));
  expect(actions.navigate).not.toHaveBeenCalled();
  await act(async () => button("Open Chat").click());
  expect(actions.navigate).toHaveBeenCalledWith("/chat");
});

it("keeps unavailable inventory and stale evidence explicit and recovers from a denied clipboard", async () => {
  await act(async () => root.render(<McpSetupProgress server={server} stale />));
  expect(container.textContent).toContain("Cached inventory unavailable");
  expect(container.textContent).toContain("last inspection");
  expect(button("Copy sample task").disabled).toBe(true);
  await act(async () => root.render(<McpSetupProgress server={server} stale={false} />));
  actions.copy.mockRejectedValueOnce(new Error("denied"));
  await act(async () => button("Copy sample task").click());
  expect(container.textContent).toContain("Copy failed");
});

it("distinguishes disabled, unknown, and enabled static Chat availability without granting callability", async () => {
  const refresh = vi.fn();
  await act(async () =>
    root.render(
      <McpSetupProgress server={server} stale={false} staticMcpAvailable={false} refreshAvailability={refresh} />,
    ),
  );
  expect(container.textContent).toContain("Static MCP in Chat is disabled");
  expect(container.textContent).toContain("reviewed settings change");
  expect(container.textContent).toContain("features.chatStaticMcpV1Enabled");
  await act(async () => button("Refresh Chat availability").click());
  expect(refresh).toHaveBeenCalledOnce();
  expect(actions.navigate).not.toHaveBeenCalled();
  expect(actions.copy).not.toHaveBeenCalled();
  await act(async () =>
    root.render(<McpSetupProgress server={server} stale={false} refreshAvailability={refresh} availabilityChecking />),
  );
  expect(container.textContent).toContain("availability in Chat is unverified");
  expect(button("Refresh Chat availability").disabled).toBe(true);
  await act(async () => root.render(<McpSetupProgress server={server} stale={false} staticMcpAvailable />));
  expect(container.textContent).toContain("Static MCP in Chat is enabled");
  expect(container.textContent).toContain("does not establish callability");
  expect(container.textContent).toContain("No task result is verified");
});

it.each([
  { ...server, connectionMode: "requester_scoped" as const },
  { ...server, serverId: "goatcitadel-internal-approval-inbox" },
])(
  "does not apply static availability guidance to an independently owned server ($serverId/$connectionMode)",
  async (record) => {
    await act(async () => root.render(<McpSetupProgress server={record} stale={false} staticMcpAvailable={false} />));
    expect(container.textContent).not.toContain("Static MCP");
    expect(container.textContent).toContain("does not establish callability");
  },
);
