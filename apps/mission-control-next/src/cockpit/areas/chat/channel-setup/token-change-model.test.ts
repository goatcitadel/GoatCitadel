import { describe, expect, it } from "vitest";
import { SAVE_KEY_WORDING } from "./telegram-key-change-model";
import { BOT_IT_USES_NOW, botChanged, botChangeNote, runningBotName, saveKeyWording } from "./token-change-model";

describe("botChangeNote", () => {
  it("warns in the words of one token", () => {
    expect(botChangeNote(false, "NewBot", "OldBot")).toBe(
      "This token is for NewBot, not OldBot. Saving it switches the bot people message.",
    );
  });

  it("warns in the words of several tokens", () => {
    expect(botChangeNote(true, "@newbot", "@oldbot")).toBe(
      "These tokens are for @newbot, not @oldbot. Saving them switches the bot people message.",
    );
  });

  it("names the bot the channel has now in general words when nothing names it", () => {
    expect(botChangeNote(false, "NewBot", undefined)).toBe(
      `This token is for NewBot, not ${BOT_IT_USES_NOW}. Saving it switches the bot people message.`,
    );
  });
});

describe("botChanged", () => {
  it("is true for a bot that differs from the one the channel saved", () => {
    expect(botChanged({ applicationId: "1000" }, "applicationId", "2000")).toBe(true);
  });

  it("ignores blanks around either id", () => {
    expect(botChanged({ applicationId: " 1000 " }, "applicationId", "1000\n")).toBe(false);
  });

  it.each([
    ["never recorded one", {}],
    ["recorded a blank", { applicationId: "  " }],
    ["recorded something that is not an id", { applicationId: 1000 }],
  ])("is false for a channel that %s: it cannot claim a switch it cannot see", (_name, config) => {
    expect(botChanged(config, "applicationId", "2000")).toBe(false);
  });
});

describe("runningBotName", () => {
  it("reads the name the running channel reports", () => {
    expect(runningBotName({ connectedBotTag: " Goat#1234 " }, "connectedBotTag")).toBe("Goat#1234");
  });

  it.each([[undefined], [{}], [{ connectedBotTag: "" }], [{ connectedBotTag: 7 }]])(
    "is nothing when the channel does not say (%j)",
    (metadata) => {
      expect(runningBotName(metadata, "connectedBotTag")).toBeUndefined();
    },
  );
});

describe("saveKeyWording", () => {
  it("keeps the button and working label of Save key and takes the channel's ending and cleanup", () => {
    const wording = saveKeyWording({ done: "Saved.", doneLink: "Back", cleanup: "Delete it." });
    expect(wording).toEqual({
      button: SAVE_KEY_WORDING.button,
      working: SAVE_KEY_WORDING.working,
      done: "Saved.",
      doneLink: "Back",
      cleanup: "Delete it.",
    });
    expect(wording.button).toBe("Save key");
  });
});
