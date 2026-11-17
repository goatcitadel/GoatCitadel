// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { expect, it } from "vitest";
import { InboxItemCard } from "./InboxItemCard";

// The Inbox projection names the target (IN-L02, inbox-projection-service approvalTargetSummary).
const item: OperatorInboxItem = {
  id: "approval:a",
  kind: "approval",
  group: "needs_decision",
  title: "Review memory write",
  summary: "Writes memory · Operator preference: visible proof",
  createdAt: "2026-10-01T00:00:00Z",
  source: { workspaceId: "w", approvalId: "a" },
  href: "/ops/approvals?approvalId=a",
};

it("names the target from the Inbox summary and never reads the approval record itself (IN-L02)", () => {
  const client = new QueryClient();
  const container = document.createElement("div"),
    root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxItemCard
          item={item}
          workspaceId="w"
          selected={false}
          contextOpen={false}
          onDetails={() => undefined}
          onToggleContext={() => undefined}
        />
      </QueryClientProvider>,
    ),
  );
  expect(container.textContent).toContain("Writes memory · Operator preference: visible proof");
  expect(container.textContent).not.toContain("Target details are available");
  expect(client.isFetching()).toBe(0);
  act(() => root.unmount());
  client.clear();
});

it("reserves quick decisions for safe file reads with the path visible", async () => {
  const { canDecideInRow } = await import("./InboxRowDecision");
  const read = { ...item, summary: "Path: notes.md", source: { ...item.source, toolName: "fs.read" } };
  expect(canDecideInRow({ ...read, riskLevel: "safe" })).toBe(true);
  expect(canDecideInRow({ ...read, riskLevel: "caution" })).toBe(false);
  expect(canDecideInRow({ ...read, riskLevel: "safe", source: { ...read.source, installWide: true } })).toBe(false);
  expect(
    canDecideInRow({ ...read, riskLevel: "safe", summary: "Target details are available in the approval record." }),
  ).toBe(false);
  expect(canDecideInRow({ ...item, riskLevel: "danger" })).toBe(false);
  expect(canDecideInRow({ ...item, riskLevel: "nuclear" })).toBe(false);
  expect(canDecideInRow({ ...item, kind: "failed_run", riskLevel: "safe" })).toBe(false);
  const container = document.createElement("div"),
    root = createRoot(container);
  const client = new QueryClient();
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <InboxItemCard
          item={{ ...item, riskLevel: "danger" }}
          workspaceId="w"
          selected={false}
          contextOpen={false}
          onDetails={() => undefined}
          onToggleContext={() => undefined}
          onDecision={() => undefined}
        />
      </QueryClientProvider>,
    ),
  );
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toContain("Review request");
  expect(container.textContent).not.toContain("Approve once");
  expect(container.querySelector("article")?.className).not.toContain("rounded-lg");
  act(() => root.unmount());
  client.clear();
});

it("distinguishes requests to write memory while keeping the decision on the review screen", () => {
  const client = new QueryClient();
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        {["Writes memory · Operator preference: visible proof", "Writes memory · Launch rule"].map((summary, index) => (
          <InboxItemCard
            key={summary}
            item={{
              ...item,
              summary,
              riskLevel: "caution",
              source: { ...item.source, toolName: "memory.write", sessionId: "s", approvalId: String(index) },
            }}
            workspaceId="w"
            selected={false}
            contextOpen={false}
            onDetails={() => undefined}
            onToggleContext={() => undefined}
            onDecision={() => undefined}
          />
        ))}
      </QueryClientProvider>,
    ),
  );
  expect([...container.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
    "Save memory: Operator preference: visible proof",
    "Save memory: Launch rule",
  ]);
  expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
    "Review request",
    "Review request",
  ]);
  expect(client.isFetching()).toBe(0);
  act(() => root.unmount());
  client.clear();
});
