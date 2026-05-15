import { describe, expect, it } from "vitest";
import { describeChatUiError, formatChatUiError } from "./chat-error-copy";
import { normalizeComparableAssistantContent } from "./chat-page-normalizers";
import { resolveSelectedTurnId } from "./chat-page-pure-helpers";
import { deriveThreadPendingApproval } from "./chat-pending-approval";
import { deriveThreadPendingUserInput, mergePendingUserInput } from "./chat-pending-user-input";

describe("threaded loop 15 pure branch tails", () => {
  it("normalizes absent assistant content without preserving whitespace", () => {
    expect(normalizeComparableAssistantContent(undefined)).toBe("");
  });

  it("covers chat error fallback branches for alternate verification copy and empty input", () => {
    expect(formatChatUiError(null)).toBeNull();
    expect(describeChatUiError("Please verify organization access before using gpt-image-2.", "image_edit")).toEqual({
      summary:
        "OpenAI blocked image generation because this API organization is not verified for gpt-image-2. Verify the organization in OpenAI Platform Settings > Organization > General, then wait a bit and retry.",
      raw: "Please verify organization access before using gpt-image-2.",
    });
  });

  it("uses active and empty pending user-input fallbacks deliberately", () => {
    expect(
      deriveThreadPendingUserInput({
        selectedTurnId: undefined,
        activeLeafTurnId: "turn-active",
        turns: [
          {
            turnId: "turn-active",
            trace: { status: "waiting_for_user_input", pendingUserInput: undefined },
          },
        ],
      } as never),
    ).toBeNull();

    expect(
      mergePendingUserInput(
        { promptId: "prompt-1", message: "Current", options: [{ label: "A", value: "a" }] } as never,
        { promptId: "prompt-1", message: "Updated", options: [{ label: "B", value: "b" }] } as never,
      ),
    ).toEqual({ promptId: "prompt-1", message: "Updated", options: [{ label: "B", value: "b" }] });
  });

  it("ignores approval-required tool runs that do not carry an approval id", () => {
    expect(
      deriveThreadPendingApproval({
        selectedTurnId: undefined,
        activeLeafTurnId: "turn-active",
        turns: [
          {
            turnId: "turn-active",
            trace: {
              status: "waiting_for_approval",
              toolRuns: [{ status: "approval_required", toolName: "fs.write" }],
            },
          },
        ],
      } as never),
    ).toBeNull();
  });

  it("uses active leaf turns before falling back to the final turn id", () => {
    expect(
      resolveSelectedTurnId(
        {
          selectedTurnId: null,
          activeLeafTurnId: "turn-active",
          turns: [{ turnId: "turn-older" }, { turnId: "turn-active" }],
        },
        null,
      ),
    ).toBe("turn-active");
  });
});
