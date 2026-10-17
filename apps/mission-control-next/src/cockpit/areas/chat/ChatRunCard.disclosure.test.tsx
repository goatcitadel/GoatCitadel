// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChatRunCard } from "./ChatRunCard";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (props: Partial<MissionThreadedActiveSessionSurfaceProps>) =>
  act(() =>
    root.render(
      <ChatRunCard
        props={{ selectedSessionId: "s", ...props } as MissionThreadedActiveSessionSurfaceProps}
        turnId="turn-1"
        durableRunId="run-1"
      />,
    ),
  );
const details = () => container.querySelector<HTMLDetailsElement>('details[aria-label="Conversation run"]')!;

it("does not open for a pending decision alone; the decision has its own card (CH-10)", () => {
  render({ hasActiveStream: false, pendingApproval: { approvalId: "a" } as never });
  expect(details().open).toBe(false);
});

it("opens while a response streams and stays open after it ends (CH-39)", () => {
  render({ hasActiveStream: true });
  expect(details().open).toBe(true);
  render({ hasActiveStream: false });
  expect(details().open).toBe(true);
});

it("keeps an operator-opened card open when the stream ends, and respects an operator close", () => {
  render({ hasActiveStream: false });
  expect(details().open).toBe(false);
  act(() => {
    details().open = true;
    details().dispatchEvent(new Event("toggle"));
  });
  render({ hasActiveStream: true });
  render({ hasActiveStream: false });
  expect(details().open).toBe(true);
  act(() => {
    details().open = false;
    details().dispatchEvent(new Event("toggle"));
  });
  render({ hasActiveStream: false });
  expect(details().open).toBe(false);
});
