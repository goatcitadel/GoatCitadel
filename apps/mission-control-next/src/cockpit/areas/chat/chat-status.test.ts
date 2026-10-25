import { expect, it } from "vitest";
import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { projectChatStatus } from "./chat-status";

const thread = (status: string) =>
  ({
    sessionId: "session-a",
    activeLeafTurnId: "turn-b",
    turns: [
      { turnId: "turn-a", trace: { status: "failed" } },
      { turnId: "turn-b", trace: { status } },
    ],
  }) as unknown as ChatThreadResponse;
const live = (overrides: Partial<Parameters<typeof projectChatStatus>[0] & object> = {}) => ({
  thread: thread("completed"),
  pendingApproval: null,
  pendingUserInput: null,
  hasActiveStream: false,
  sending: false,
  ...overrides,
});

it("puts a decision you owe ahead of work in flight", () => {
  expect(
    projectChatStatus(live({ hasActiveStream: true, pendingApproval: { approvalId: "approval-a" } as never })),
  ).toEqual({ label: "Waiting on you: approval", tone: "waiting" });
});

it("reports streaming and sending as running work", () => {
  expect(projectChatStatus(live({ hasActiveStream: true }))).toEqual({ label: "Working", tone: "running" });
  expect(projectChatStatus(live({ sending: true }))).toEqual({ label: "Sending", tone: "running" });
});

it("reads the active leaf turn, not an earlier one", () => {
  expect(projectChatStatus(live())).toEqual({ label: "Last response completed", tone: "done" });
  expect(projectChatStatus(live({ thread: thread("failed") }))).toEqual({
    label: "Last response failed",
    tone: "failed",
  });
});

it("does not ask for a decision again, nor claim the run resumed, while the thread still shows it waiting", () => {
  expect(projectChatStatus(live({ thread: thread("waiting_for_approval") }))).toEqual({
    label: "Decided · resume unconfirmed",
    tone: "waiting",
  });
});

it("says so when there is no open conversation to read", () => {
  expect(projectChatStatus(null)).toEqual({ label: "Status unavailable", tone: "neutral" });
});
