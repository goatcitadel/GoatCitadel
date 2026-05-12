import React, { useRef } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveChatStreamState } from "./useChatOutboundExecution";
import { useChatApprovalController } from "./useChatApprovalController";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setters = {
  setPendingAttachments: vi.fn(),
  setEditingTurnId: vi.fn(),
  setPendingApproval: vi.fn(),
  setPendingUserInput: vi.fn(),
  setDelegationSuggestion: vi.fn(),
  setCapabilitySuggestions: vi.fn(),
  setSpecialistSuggestions: vi.fn(),
  setSelectedTurnId: vi.fn(),
  setLocalNotices: vi.fn(),
  pushLocalNotice: vi.fn(),
};

let activeStreamRefSnapshot: React.MutableRefObject<ActiveChatStreamState | null> | null = null;

function Harness(props: { selectedSessionId: string | null; activeStream?: ActiveChatStreamState | null }) {
  const activeStreamRef = useRef<ActiveChatStreamState | null>(props.activeStream ?? null);
  activeStreamRefSnapshot = activeStreamRef;
  useChatApprovalController({
    selectedSessionId: props.selectedSessionId,
    activeStreamRef,
    ...setters,
  });
  return null;
}

function makeStream(): ActiveChatStreamState {
  return {
    sessionId: "session-1",
    streamToken: "stream-1",
    controller: new AbortController(),
  };
}

describe("useChatApprovalController", () => {
  beforeEach(() => {
    Object.values(setters).forEach((mock) => mock.mockReset());
    activeStreamRefSnapshot = null;
  });

  it("clears shell state when no session is selected", async () => {
    const stream = makeStream();
    const abortSpy = vi.spyOn(stream.controller, "abort");

    await act(async () => {
      create(<Harness selectedSessionId={null} activeStream={stream} />);
    });

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(activeStreamRefSnapshot!.current).toBeNull();
    expect(setters.setSelectedTurnId).toHaveBeenCalledWith(null);
    expect(setters.setLocalNotices).toHaveBeenCalledWith([]);
    expect(setters.setPendingAttachments).toHaveBeenCalledWith([]);
    expect(setters.setDelegationSuggestion).toHaveBeenCalledWith(null);
    expect(setters.setCapabilitySuggestions).toHaveBeenCalledWith([]);
    expect(setters.setSpecialistSuggestions).toHaveBeenCalledWith([]);
    expect(setters.setPendingApproval).toHaveBeenCalledWith(null);
    expect(setters.setPendingUserInput).toHaveBeenCalledWith(null);
  });

  it("resets state and warns when switching sessions with an active stream", async () => {
    const stream = makeStream();
    const abortSpy = vi.spyOn(stream.controller, "abort");
    let renderer!: ReactTestRenderer;

    await act(async () => {
      renderer = create(<Harness selectedSessionId="session-1" />);
    });
    Object.values(setters).forEach((mock) => mock.mockClear());
    activeStreamRefSnapshot!.current = stream;

    await act(async () => {
      renderer.update(<Harness selectedSessionId="session-2" />);
    });

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(activeStreamRefSnapshot!.current).toBeNull();
    expect(setters.pushLocalNotice).toHaveBeenCalledWith(
      "Stream interrupted - switched sessions. The previous turn may still be processing on the server.",
      "warning",
    );
    expect(setters.setEditingTurnId).toHaveBeenCalledWith(null);
    expect(setters.setPendingApproval).toHaveBeenCalledWith(null);
    expect(setters.setPendingUserInput).toHaveBeenCalledWith(null);
  });
});
