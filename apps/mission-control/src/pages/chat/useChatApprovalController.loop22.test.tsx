import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatApprovalController } from "./useChatApprovalController";

const abortMock = vi.hoisted(() => vi.fn());

vi.mock("./useChatOutboundExecution", () => ({
  abortActiveChatStream: abortMock,
}));

type Calls = ReturnType<typeof createCalls>;

function createCalls() {
  return {
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
}

function Harness(props: {
  selectedSessionId: string | null;
  activeStreamRef: React.MutableRefObject<unknown>;
  calls: Calls;
}) {
  useChatApprovalController({
    selectedSessionId: props.selectedSessionId,
    activeStreamRef: props.activeStreamRef as never,
    setPendingAttachments: props.calls.setPendingAttachments,
    setEditingTurnId: props.calls.setEditingTurnId,
    setPendingApproval: props.calls.setPendingApproval,
    setPendingUserInput: props.calls.setPendingUserInput,
    setDelegationSuggestion: props.calls.setDelegationSuggestion,
    setCapabilitySuggestions: props.calls.setCapabilitySuggestions,
    setSpecialistSuggestions: props.calls.setSpecialistSuggestions,
    setSelectedTurnId: props.calls.setSelectedTurnId,
    setLocalNotices: props.calls.setLocalNotices,
    pushLocalNotice: props.calls.pushLocalNotice,
  });

  return <span>{props.selectedSessionId ?? "none"}</span>;
}

describe("useChatApprovalController", () => {
  beforeEach(() => {
    abortMock.mockClear();
  });

  it("clears local pending state when the shell has no selected session", () => {
    const calls = createCalls();
    const stream = { streamToken: "stream-1" };
    const activeStreamRef = { current: stream } as React.MutableRefObject<unknown>;

    act(() => {
      create(<Harness activeStreamRef={activeStreamRef} calls={calls} selectedSessionId={null} />);
    });

    expect(abortMock).toHaveBeenCalledWith(stream);
    expect(activeStreamRef.current).toBeNull();
    expect(calls.setSelectedTurnId).toHaveBeenCalledWith(null);
    expect(calls.setLocalNotices).toHaveBeenCalledWith([]);
    expect(calls.setPendingAttachments).toHaveBeenCalledWith([]);
    expect(calls.setDelegationSuggestion).toHaveBeenCalledWith(null);
    expect(calls.setCapabilitySuggestions).toHaveBeenCalledWith([]);
    expect(calls.setSpecialistSuggestions).toHaveBeenCalledWith([]);
    expect(calls.setPendingApproval).toHaveBeenCalledWith(null);
    expect(calls.setPendingUserInput).toHaveBeenCalledWith(null);
  });

  it("aborts stale streams and warns the operator when switching sessions", () => {
    const calls = createCalls();
    const activeStreamRef = { current: null } as React.MutableRefObject<unknown>;
    const renderer = create(<Harness activeStreamRef={activeStreamRef} calls={calls} selectedSessionId="session-a" />);

    abortMock.mockClear();
    for (const mock of Object.values(calls)) {
      mock.mockClear();
    }

    const stream = { streamToken: "stream-2" };
    activeStreamRef.current = stream;

    act(() => {
      renderer.update(<Harness activeStreamRef={activeStreamRef} calls={calls} selectedSessionId="session-b" />);
    });

    expect(abortMock).toHaveBeenCalledWith(stream);
    expect(activeStreamRef.current).toBeNull();
    expect(calls.pushLocalNotice).toHaveBeenCalledWith(expect.stringContaining("Stream interrupted"), "warning");
    expect(calls.setPendingAttachments).toHaveBeenCalledWith([]);
    expect(calls.setSelectedTurnId).toHaveBeenCalledWith(null);
    expect(calls.setEditingTurnId).toHaveBeenCalledWith(null);
    expect(calls.setLocalNotices).toHaveBeenCalledWith([]);
    expect(calls.setPendingApproval).toHaveBeenCalledWith(null);
    expect(calls.setPendingUserInput).toHaveBeenCalledWith(null);
    expect(calls.setDelegationSuggestion).toHaveBeenCalledWith(null);
    expect(calls.setCapabilitySuggestions).toHaveBeenCalledWith([]);
    expect(calls.setSpecialistSuggestions).toHaveBeenCalledWith([]);
  });
});
