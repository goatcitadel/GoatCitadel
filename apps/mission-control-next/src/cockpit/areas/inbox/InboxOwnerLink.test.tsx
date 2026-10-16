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
        source: { workspaceId: "w", approvalId: "a" },
        href: "/ops/approvals?approvalId=a",
      },
    ]);
    expect(health?.textContent).toBe("Open in System");
    expect(health?.getAttribute("href")).toContain("/system/health");
    expect(run?.textContent).toBe("Open in Work");
    expect(run?.getAttribute("href")).toContain("/work/runs/run-a");
    expect(approval?.textContent).toBe("Open approval");
    expect(approval?.getAttribute("href")).toContain("/inbox?approvalId=a");
  } finally {
    window.history.replaceState(null, "", originalLocation);
  }
});
