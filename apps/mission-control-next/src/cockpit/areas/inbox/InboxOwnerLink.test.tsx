// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { expect, it } from "vitest";
import { InboxOwnerLink } from "./InboxOwnerLink";

const base: OperatorInboxItem = {
  id: "runtime_health:gateway",
  kind: "runtime_health",
  group: "needs_attention",
  title: "Runtime health",
  summary: "Degraded",
  createdAt: "2026-10-01T00:00:00Z",
  source: { workspaceId: "w" },
  href: "/system/health",
};

function renderLinks(items: OperatorInboxItem[]): HTMLAnchorElement[] {
  const container = document.createElement("div"),
    root = createRoot(container);
  act(() =>
    root.render(
      <>
        {items.map((item) => (
          <InboxOwnerLink key={item.id} item={item} workspaceId="w" />
        ))}
      </>,
    ),
  );
  const links = [...container.querySelectorAll("a")];
  act(() => root.unmount());
  return links;
}

it("names each owner link by the cockpit area it opens, never Ops or Approvals (IN-19)", () => {
  const originalLocation = window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState(null, "", "/inbox?shell=cockpit");
  try {
    const [health, run, approval] = renderLinks([
      base,
      {
        ...base,
        id: "failed_run:run-a",
        kind: "failed_run",
        source: { workspaceId: "w", runId: "run-a" },
        href: "/ops/runtime?runId=run-a",
      },
      {
        ...base,
        id: "approval:a",
        kind: "approval",
        group: "needs_decision",
        source: { workspaceId: "w", approvalId: "a", sessionId: "s1" },
        href: "/ops/approvals?approvalId=a",
      },
    ]);
    expect(health?.textContent).toBe("Open in System");
    expect(health?.getAttribute("href")).toContain("/system/health");
    expect(run?.textContent).toBe("Open in Work");
    expect(run?.getAttribute("href")).toContain("/work/runs/run-a");
    expect(approval?.textContent).toBe("Open in Chat");
    expect(approval?.getAttribute("href")).toContain("/chat?");
  } finally {
    window.history.replaceState(null, "", originalLocation);
  }
});

const decisionBase: OperatorInboxItem = {
  ...base,
  id: "approval:a",
  kind: "approval",
  group: "needs_decision",
  source: { workspaceId: "w", approvalId: "a" },
  href: "/inbox?approvalId=a",
};

function withAddress<T>(search: string, run: () => T): T {
  const original = window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState(null, "", "/inbox" + search);
  try {
    return run();
  } finally {
    window.history.replaceState(null, "", original);
  }
}

it("opens the conversation an approval came from, not the Inbox again (U-IN-014)", () => {
  const [link] = withAddress("?shell=cockpit&approvalId=a", () =>
    renderLinks([{ ...decisionBase, source: { ...decisionBase.source, sessionId: "s1", turnId: "t1" } }]),
  );
  expect(link?.textContent).toBe("Open in Chat");
  const target = new URL(link!.href);
  expect(target.pathname).toBe("/chat");
  expect(target.searchParams.get("sessionId")).toBe("s1");
  expect(target.searchParams.get("turnId")).toBe("t1");
  expect(target.searchParams.get("workspaceId")).toBe("w");
  expect(target.searchParams.has("approvalId")).toBe(false);
});

it("opens the run an approval belongs to when it has no conversation", () => {
  const [link] = withAddress("?shell=cockpit", () =>
    renderLinks([{ ...decisionBase, source: { ...decisionBase.source, runId: "r1" } }]),
  );
  expect(link?.textContent).toBe("Open in Work");
  expect(new URL(link!.href).pathname).toBe("/work/runs/r1");
});

it("shows no link for an approval with neither a conversation nor a run", () => {
  expect(withAddress("?shell=cockpit", () => renderLinks([decisionBase]))).toHaveLength(0);
});

it("opens the conversation of a user input request, and nothing for a change plan without one", () => {
  const [input, plan] = withAddress("?shell=cockpit", () =>
    renderLinks([
      {
        ...decisionBase,
        id: "user_input:u",
        kind: "user_input",
        source: { workspaceId: "w", sessionId: "s2" },
      },
      { ...decisionBase, id: "change_plan:p", kind: "change_plan", source: { workspaceId: "w", planId: "p" } },
    ]),
  );
  expect(input?.textContent).toBe("Open in Chat");
  expect(new URL(input!.href).searchParams.get("sessionId")).toBe("s2");
  expect(plan).toBeUndefined();
});
