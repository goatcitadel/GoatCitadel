// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupFieldDefinition } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelStructuredField } from "./ChannelStructuredField";

const field: ChannelSetupFieldDefinition = {
  key: "allowedSenders",
  label: "Allowed sender identities",
  type: "sender-list",
  required: false,
  explanation: "Who may start a conversation.",
};
const droppedAt = new Date(Date.now() - 5 * 60_000).toISOString();

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(
  value: unknown,
  droppedSenders: { senderId: string; droppedAt: string }[] | undefined,
  onChange = vi.fn(),
) {
  await act(async () => {
    root.render(
      <ChannelStructuredField
        field={field}
        value={value}
        id="senders"
        describedBy="senders-help"
        disabled={false}
        inputClassName="input"
        droppedSenders={droppedSenders}
        onChange={onChange}
      />,
    );
  });
  return onChange;
}

const buttons = () => [...container.querySelectorAll("button")].map((button) => button.textContent);

describe("a sender list offers the senders the bot turned away", () => {
  it("offers only a sender that is not already allowed, and allows it into the draft", async () => {
    const onChange = await mount(
      ["U1"],
      [
        { senderId: "U1", droppedAt },
        { senderId: "U2", droppedAt },
      ],
    );
    expect(container.querySelector("h4")?.textContent).toBe("Recently turned away");
    expect(buttons()).toEqual(["Allow U2"]);
    expect(container.textContent).toContain("A message from U2 was turned away");
    expect(container.textContent).toContain(
      "Allowing a sender changes this draft. Save and finish the setup to apply it. GoatCitadel keeps this list for 30 minutes and clears it when it restarts.",
    );
    await act(async () => container.querySelector("button")!.click());
    expect(onChange).toHaveBeenCalledWith(["U1", "U2"]);
  });

  it("shows nothing extra when no sender was turned away, or when the list was not read", async () => {
    await mount(["U1"], []);
    expect(container.querySelector("h4")).toBeNull();
    await mount(["U1"], undefined);
    expect(container.querySelector("h4")).toBeNull();
    expect(buttons()).toEqual([]);
  });

  it("shows nothing extra when every turned away sender is already allowed", async () => {
    await mount("U1\nU2", [{ senderId: "U2", droppedAt }]);
    expect(container.querySelector("h4")).toBeNull();
  });
});
