import { describe, expect, it } from "vitest";
import { approvalWords } from "./skill-install-view";

describe("approvalWords", () => {
  it("tells the switch-on approval that Chat needs Skills in Chat", () => {
    expect(approvalWords("waiting_switch_on", "Planner", false).summary).toBe(
      "Lets the AI use Planner in new chats once Skills in Chat is turned on in Settings › Advanced.",
    );
    expect(approvalWords("waiting_switch_on", "Planner", true).summary).toBe("Lets the AI use Planner in new chats.");
    expect(approvalWords("waiting_switch_on", "Planner").summary).toBe("Lets the AI use Planner in new chats.");
  });
  it("leaves the install approval alone", () => {
    expect(approvalWords("waiting_install", "Planner", false).summary).toBe(
      "Installs Planner switched off. It can't be used until you switch it on.",
    );
  });
});
