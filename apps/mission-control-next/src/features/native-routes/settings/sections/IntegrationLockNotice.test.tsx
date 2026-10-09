// @vitest-environment happy-dom
import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { IntegrationLockNotice } from "./IntegrationLockNotice";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ fetchIntegrationConnections: vi.fn() }));
let view: ReactTestRenderer;
const text = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(text).join("");
afterEach(async () => {
  await act(async () => view?.unmount());
});

function lockedMutation(checkOutcome: (readback: () => Promise<unknown>) => Promise<string | undefined>) {
  return {
    phase: "uncertain" as const,
    message: "Outcome uncertain.",
    transport: { attemptKey: "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b", method: "POST" as const, routePattern: "/x" },
    pending: false,
    locked: true,
    checkOutcome,
  };
}

it("settles only through the owner's own canonical readback, then the section reload", async () => {
  const order: string[] = [];
  const readback = vi.fn(async () => order.push("owner-read"));
  const reload = vi.fn(async () => order.push("reload"));
  const checkOutcome = vi.fn(async (check: () => Promise<unknown>) => {
    await check();
    return "The Gateway recorded this integration change as processed.";
  });
  await act(async () => {
    view = create(
      <IntegrationLockNotice mutation={lockedMutation(checkOutcome)} readback={readback} reload={reload} />,
    );
  });
  const button = view.root.findAllByType("button").find((node) => text(node) === "Check outcome")!;
  await act(async () => button.props.onClick());
  expect(order).toEqual(["owner-read", "reload"]);
});

it("fails the check when the owner's readback fails, so the lock is kept", async () => {
  const readback = vi.fn(async () => {
    throw new Error("owner read unavailable");
  });
  let failed = false;
  const checkOutcome = vi.fn(async (check: () => Promise<unknown>) => {
    await check().catch(() => {
      failed = true;
    });
    return undefined;
  });
  await act(async () => {
    view = create(
      <IntegrationLockNotice mutation={lockedMutation(checkOutcome)} readback={readback} reload={vi.fn()} />,
    );
  });
  const button = view.root.findAllByType("button").find((node) => text(node) === "Check outcome")!;
  await act(async () => button.props.onClick());
  expect(failed).toBe(true);
});
