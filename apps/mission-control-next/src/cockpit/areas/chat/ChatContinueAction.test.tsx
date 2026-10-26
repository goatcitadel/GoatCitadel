// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { ChatContinueAction } from "./ChatContinueAction";
import { CONTINUE_MESSAGE } from "./chat-continue";

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

const stopped = (status = "cancelled", content = "Partial text") =>
  ({ turnId: "t1", trace: { status }, assistantMessage: { content } }) as unknown as ChatThreadTurnRecord;

function props(over: Record<string, unknown> = {}) {
  return {
    draft: "",
    canSend: true,
    sending: false,
    hasActiveStream: false,
    historicalReadOnly: false,
    pendingAttachments: [],
    commandSuggestions: [],
    selectedSessionId: "s1",
    onDraftChange: vi.fn(),
    onSend: vi.fn(),
    ...over,
  } as unknown as MissionThreadedActiveSessionSurfaceProps;
}

function render(turn: ChatThreadTurnRecord, isLatest: boolean, p: MissionThreadedActiveSessionSurfaceProps) {
  act(() => root.render(<ChatContinueAction turn={turn} isLatest={isLatest} actions={p} />));
}
const button = () => container.querySelector("button");

describe("ChatContinueAction visibility", () => {
  it("shows on the latest stopped turn that kept text", () => {
    render(stopped(), true, props());
    expect(button()?.textContent).toBe("Continue");
  });
  it.each([
    ["an older turn", stopped(), false, {}],
    ["a completed turn", stopped("completed"), true, {}],
    ["a stopped turn with no text", stopped("cancelled", "  "), true, {}],
    ["while sending", stopped(), true, { sending: true }],
    ["while a stream runs", stopped(), true, { hasActiveStream: true }],
    ["with a pending approval", stopped(), true, { pendingApproval: { approvalId: "a" } }],
    ["in a read-only view", stopped(), true, { historicalReadOnly: true }],
    ["with a draft in the composer", stopped(), true, { draft: "my own text" }],
  ])("is hidden for %s", (_name, turn, latest, over) => {
    render(turn, latest, props(over));
    expect(button()).toBeNull();
  });
});

describe("ChatContinueAction click", () => {
  it("puts the continuation in the composer, then sends through the normal handler", () => {
    const p = props();
    render(stopped(), true, p);
    act(() => button()?.click());
    expect(p.onDraftChange).toHaveBeenCalledWith(CONTINUE_MESSAGE);
    expect(p.onSend).not.toHaveBeenCalled();
    render(stopped(), true, { ...p, draft: CONTINUE_MESSAGE });
    expect(p.onSend).toHaveBeenCalledTimes(1);
  });

  it("leaves the message in the composer when sending became blocked", () => {
    const p = props();
    render(stopped(), true, p);
    act(() => button()?.click());
    render(stopped(), true, { ...p, draft: CONTINUE_MESSAGE, pendingApproval: { approvalId: "a" } } as never);
    expect(p.onSend).not.toHaveBeenCalled();
  });
});
