import { describe, expect, it } from "vitest";
import { deriveThreadPendingUserInput, mergePendingUserInput } from "./chat-pending-user-input";

describe("chat-pending-user-input", () => {
  it("derives pending prompts from the selected or active thread turn", () => {
    expect(deriveThreadPendingUserInput(null)).toBeNull();
    expect(
      deriveThreadPendingUserInput({
        selectedTurnId: "turn-2",
        activeLeafTurnId: "turn-1",
        turns: [
          { turnId: "turn-1", trace: { status: "waiting_for_user_input", pendingUserInput: { promptId: "prompt-1" } } },
          { turnId: "turn-2", trace: { status: "completed" } },
        ],
      } as never),
    ).toBeNull();
    expect(
      deriveThreadPendingUserInput({
        activeLeafTurnId: "turn-1",
        turns: [
          {
            turnId: "turn-1",
            trace: { status: "waiting_for_user_input", pendingUserInput: { promptId: "prompt-1", message: "Decide" } },
          },
        ],
      } as never),
    ).toEqual({ promptId: "prompt-1", message: "Decide" });
    expect(deriveThreadPendingUserInput({ turns: [] } as never)).toBeNull();
  });

  it("merges prompt updates without dropping existing options", () => {
    expect(mergePendingUserInput({ promptId: "prompt-1", message: "Current" } as never, null)).toEqual({
      promptId: "prompt-1",
      message: "Current",
    });
    expect(mergePendingUserInput(null, { promptId: "prompt-2", message: "Next" } as never)).toEqual({
      promptId: "prompt-2",
      message: "Next",
    });
    expect(
      mergePendingUserInput(
        { promptId: "prompt-1", message: "Current", options: [{ label: "A", value: "a" }] } as never,
        { promptId: "prompt-1", message: "Updated" } as never,
      ),
    ).toEqual({ promptId: "prompt-1", message: "Updated", options: [{ label: "A", value: "a" }] });
  });
});
