// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { useTurnSkillCapture } from "./use-turn-skill-capture";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetApprovalOperationAttemptsForTests } from "../inbox/approval-operation-attempts";

vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  prepareWorkflowSkillCapture: vi.fn(),
  fetchCapabilityProposals: vi.fn(async () => ({ items: [] })),
  fetchCapabilityCandidate: vi.fn(),
  fetchChangePlan: vi.fn(),
  stageWorkflowSkillCapture: vi.fn(),
  createChangePlan: vi.fn(),
}));

const turn = {
  turnId: "turn-1",
  trace: { status: "completed", completion: { status: "complete" } },
  userMessage: { content: "Summarize the launch." },
  assistantMessage: { content: "The launch is ready for review." },
} as unknown as ChatThreadTurnRecord;
const actions = {
  workspaceId: "default",
  selectedSessionId: "session-focus",
  onDraftChange: vi.fn(),
  composerRef: { current: null },
};

let latest: ReturnType<typeof useTurnSkillCapture>;
function Harness() {
  latest = useTurnSkillCapture(turn, actions as never, true, true);
  return (
    <article>
      <button type="button" aria-label="More message actions">
        More
      </button>
      {latest.control}
    </article>
  );
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  __resetSessionViewStateForTests();
  __resetSessionDraftsForTests();
  __resetApprovalOperationAttemptsForTests();
});

const more = () => container.querySelector<HTMLElement>('button[aria-label="More message actions"]')!;
const details = () => container.querySelector("details");

describe("Save as skill focus", () => {
  it("moves focus into the block when the menu opens it, and back to More when it closes", async () => {
    await act(async () => root.render(<Harness />));
    expect(details()).toBeNull();
    more().focus();
    await act(async () => latest.onSaveAsSkill!());
    await vi.waitFor(() => expect(details()).not.toBeNull());
    await vi.waitFor(() => expect(details()!.contains(document.activeElement)).toBe(true));
    await act(async () => container.querySelector("summary")!.click());
    await vi.waitFor(() => expect(details()).toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(more()));
  });

  it("does not move focus when the block is mounted again for an earlier request", async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => latest.onSaveAsSkill!());
    await vi.waitFor(() => expect(details()!.contains(document.activeElement)).toBe(true));
    await act(async () => root.render(null));
    await act(async () => root.render(null));
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await act(async () => root.render(<Harness />));
    await vi.waitFor(() => expect(details()).not.toBeNull());
    expect(details()!.open).toBe(true);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
