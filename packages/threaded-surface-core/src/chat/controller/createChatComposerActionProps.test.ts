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
