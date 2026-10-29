import { describe, expect, it } from "vitest";
import { CHAT_TURN_REASONING_MAX_CHARS } from "@goatcitadel/contracts";
import { ChatTurnReasoningRecorder } from "./chat-turn-reasoning.js";

describe("ChatTurnReasoningRecorder", () => {
  it("adds nothing to the trace patch, and reads nothing, when a pass streamed no reasoning", async () => {
    const recorder = new ChatTurnReasoningRecorder();
    let reads = 0;
    recorder.append("   ");
    expect(
      await recorder.tracePatch(async () => {
        reads += 1;
        return "earlier";
      }),
    ).toEqual({});
    expect(reads).toBe(0);
  });

  it("saves the streamed text, appended to what an earlier pass saved", async () => {
    const recorder = new ChatTurnReasoningRecorder();
    recorder.append("Now the tool ");
    recorder.append("has answered.");
    expect(await recorder.tracePatch(async () => undefined)).toEqual({ reasoning: "Now the tool has answered." });
    expect(await recorder.tracePatch(async () => "I need approval first.")).toEqual({
      reasoning: "I need approval first.\n\nNow the tool has answered.",
    });
  });

  it("redacts secrets the model repeats in its reasoning before they are saved", async () => {
    const recorder = new ChatTurnReasoningRecorder();
    recorder.append("The key is sk-ant-api03-");
    recorder.append("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX so I use it.");
    const { reasoning } = await recorder.tracePatch(async () => undefined);
    expect(reasoning).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(reasoning).toContain("so I use it.");
  });

  it("keeps the newest reasoning within the saved cap", async () => {
    const recorder = new ChatTurnReasoningRecorder();
    for (let index = 0; index < 50; index += 1) recorder.append(`${"x".repeat(999)}${index % 10}`);
    recorder.append("final step");
    const { reasoning } = await recorder.tracePatch(async () => undefined);
    expect(reasoning?.length).toBe(CHAT_TURN_REASONING_MAX_CHARS);
    expect(reasoning?.startsWith("… ")).toBe(true);
    expect(reasoning?.endsWith("final step")).toBe(true);
  });
});
