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
    ownerKey: "original",
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

it.each(["before", "after"] as const)(
  "hides a settled outcome when the target switches %s the check resolves",
  async (timing) => {
    const message = "The Gateway recorded the original connection change.";
    let resolveOutcome!: (value: string) => void;
    const outcome = new Promise<string>((resolve) => {
      resolveOutcome = resolve;
    });
    const checkOutcome = vi.fn(() => outcome);
    const render = (target: string, settled = false) => {
      const locked = lockedMutation(checkOutcome);
      const mutation =
        target === "original" && !settled
          ? locked
          : {
              ...locked,
              phase: "idle" as const,
              pending: false,
              locked: false,
            };
      return <IntegrationLockNotice mutation={{ ...mutation, ownerKey: target }} readback={vi.fn()} reload={vi.fn()} />;
    };
    await act(async () => {
      view = create(render("original"));
    });
    const button = view.root.findAllByType("button").find((node) => text(node) === "Check outcome")!;
    await act(async () => {
      button.props.onClick();
    });
    if (timing === "after") {
      await act(async () => {
        resolveOutcome(message);
        view.update(render("original", true));
      });
      expect(text(view.root)).toContain(message);
    }
    await act(async () => {
      view.update(render("replacement"));
    });
    if (timing === "before")
      await act(async () => {
        resolveOutcome(message);
      });
    expect(view.toJSON()).toBeNull();
  },
);
