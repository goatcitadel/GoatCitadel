import { describe, expect, it, vi } from "vitest";
import { createChatComposerActionProps } from "./createChatComposerActionProps";

type Input = Parameters<typeof createChatComposerActionProps>[0];

/** Builds the action props with only what `onSetWebMode` touches. Every other collaborator is an empty stub. */
function actionProps(historical: boolean) {
  const handleSetWebMode = vi.fn();
  const props = createChatComposerActionProps({
    blockHistoricalMutation: () => historical,
    failedAutoImageRecovery: null,
    selectedSessionId: null,
    draft: "",
    composerInteractions: {},
    orchestration: {},
    knowledgeActions: {},
    externalControl: { sessionControlBannerModel: { externalControlActive: false } },
    coordination: { activeStreamRef: { current: null } },
    planningPreferences: { handleSetWebMode },
    oneShotContext: {},
  } as unknown as Input);
  return { props, handleSetWebMode };
}

describe("composer action props", () => {
  it("hands the chosen web mode to the planning preferences", () => {
    const { props, handleSetWebMode } = actionProps(false);
    props.onSetWebMode?.("deep");
    expect(handleSetWebMode).toHaveBeenCalledTimes(1);
    expect(handleSetWebMode).toHaveBeenCalledWith("deep");
  });

  it("does not change the web mode while an earlier version of the conversation is open", () => {
    const { props, handleSetWebMode } = actionProps(true);
    props.onSetWebMode?.("off");
    expect(handleSetWebMode).not.toHaveBeenCalled();
  });
});

/** Builds the action props with real one-shot refs so Council and snapshot arming can be observed. */
function oneShotActionProps(input: {
  historical?: boolean;
  modelCouncilAvailable: boolean;
  workspaceSnapshotAvailable: boolean;
  councilArmed?: boolean;
  snapshotArmed?: boolean;
}) {
  const oneShotContext = {
    modelCouncilEnabledRef: { current: input.councilArmed ?? false },
    setModelCouncilEnabled: vi.fn(),
    workspaceSnapshotRequestRef: {
      current: input.snapshotArmed ? { capture: true as const, requestId: "snapshot-saved" } : undefined,
    },
    setWorkspaceSnapshotRequest: vi.fn(),
    setFullWebAccess: vi.fn(),
  };
  const props = createChatComposerActionProps({
    blockHistoricalMutation: () => input.historical ?? false,
    failedAutoImageRecovery: null,
    selectedSessionId: null,
    draft: "",
    composerInteractions: {},
    orchestration: {},
    knowledgeActions: {},
    externalControl: { sessionControlBannerModel: { externalControlActive: false } },
    coordination: { activeStreamRef: { current: null } },
    planningPreferences: {},
    oneShotContext,
    modelCouncilAvailable: input.modelCouncilAvailable,
    workspaceSnapshotAvailable: input.workspaceSnapshotAvailable,
  } as unknown as Input);
  return { props, oneShotContext };
}

describe("composer one-shot Council and workspace snapshot actions", () => {
  it("arms Council for the next send only while the Gateway reports it available", () => {
    const available = oneShotActionProps({ modelCouncilAvailable: true, workspaceSnapshotAvailable: false });
    available.props.onToggleModelCouncil?.();
    expect(available.oneShotContext.modelCouncilEnabledRef.current).toBe(true);
    expect(available.oneShotContext.setModelCouncilEnabled).toHaveBeenCalledWith(true);

    const unavailable = oneShotActionProps({ modelCouncilAvailable: false, workspaceSnapshotAvailable: false });
    unavailable.props.onToggleModelCouncil?.();
    expect(unavailable.oneShotContext.modelCouncilEnabledRef.current).toBe(false);
    expect(unavailable.oneShotContext.setModelCouncilEnabled).toHaveBeenCalledWith(false);
  });

  it.each([true, false])("always turns an armed Council off (available=%s)", (modelCouncilAvailable) => {
    const { props, oneShotContext } = oneShotActionProps({
      modelCouncilAvailable,
      workspaceSnapshotAvailable: false,
      councilArmed: true,
    });
    props.onToggleModelCouncil?.();
    expect(oneShotContext.modelCouncilEnabledRef.current).toBe(false);
    expect(oneShotContext.setModelCouncilEnabled).toHaveBeenCalledWith(false);
  });

  it("requests a fresh capture-only workspace snapshot when available", () => {
    const { props, oneShotContext } = oneShotActionProps({
      modelCouncilAvailable: false,
      workspaceSnapshotAvailable: true,
    });
    props.onToggleWorkspaceSnapshot();
    const request = oneShotContext.workspaceSnapshotRequestRef.current;
    // The Gateway accepts request ids matching /^[A-Za-z0-9._:-]{1,128}$/.
    expect(request).toEqual({ capture: true, requestId: expect.stringMatching(/^snapshot-[A-Za-z0-9._:-]{1,119}$/u) });
    expect(oneShotContext.setWorkspaceSnapshotRequest).toHaveBeenCalledWith(request);
  });

  it("does not request a workspace snapshot while unavailable, but still removes a saved one", () => {
    const unavailable = oneShotActionProps({ modelCouncilAvailable: false, workspaceSnapshotAvailable: false });
    unavailable.props.onToggleWorkspaceSnapshot();
    expect(unavailable.oneShotContext.workspaceSnapshotRequestRef.current).toBeUndefined();
    expect(unavailable.oneShotContext.setWorkspaceSnapshotRequest).not.toHaveBeenCalled();

    const saved = oneShotActionProps({
      modelCouncilAvailable: false,
      workspaceSnapshotAvailable: false,
      snapshotArmed: true,
    });
    saved.props.onToggleWorkspaceSnapshot();
    expect(saved.oneShotContext.workspaceSnapshotRequestRef.current).toBeUndefined();
    expect(saved.oneShotContext.setWorkspaceSnapshotRequest).toHaveBeenCalledWith(undefined);
  });

  it("changes neither arming while an earlier version of the conversation is open", () => {
    const { props, oneShotContext } = oneShotActionProps({
      historical: true,
      modelCouncilAvailable: true,
      workspaceSnapshotAvailable: true,
    });
    props.onToggleModelCouncil?.();
    props.onToggleWorkspaceSnapshot();
    expect(oneShotContext.setModelCouncilEnabled).not.toHaveBeenCalled();
    expect(oneShotContext.setWorkspaceSnapshotRequest).not.toHaveBeenCalled();
  });
});
