// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnOnStep, turnOnChanges } from "./TurnOnStep";
import type { useTurnOn } from "./use-turn-on";

type TurnOn = ReturnType<typeof useTurnOn>;

const CHANGES = [
  "Who can message your bot: Ada Lovelace",
  "Where it posts: your chat with @MyGoatBot",
  "How it gets messages: GoatCitadel asks Telegram for new ones, so no public web address is needed",
  "GoatCitadel sends a test message to your chat and then removes it",
];

function turnOnState(overrides: Partial<TurnOn> = {}): TurnOn {
  return {
    state: "idle",
    reasons: [],
    turnOn: vi.fn(async () => undefined),
    acknowledgeCleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

async function show(
  turnOn: TurnOn,
  props: { onTurnOn?: () => void; doneHref?: string; disabled?: boolean; changes?: readonly string[] } = {},
) {
  await act(async () => {
    root.render(
      <TurnOnStep
        changes={props.changes ?? CHANGES}
        turnOn={turnOn}
        onTurnOn={props.onTurnOn ?? (() => undefined)}
        doneHref={props.doneHref}
        disabled={props.disabled}
        workspaceId="default"
        settingsHref="/settings/connections?channel=channel.telegram#channels"
      />,
    );
  });
}

const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];
const button = (text: string) => buttons().find((candidate) => candidate.textContent?.trim() === text);
const link = (text: string) =>
  [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) => candidate.textContent?.includes(text));

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("turnOnChanges", () => {
  it("lists what turning on will do, in the words the operator reads", () => {
    expect(turnOnChanges({ senderName: "Ada Lovelace", botUsername: "MyGoatBot", missingHosts: [] })).toEqual(CHANGES);
  });

  it("names a host that has to be added, and only a host that has to be added", () => {
    const lines = turnOnChanges({
      senderName: "Ada Lovelace",
      botUsername: "MyGoatBot",
      missingHosts: ["api.telegram.org"],
    });
    expect(lines).toEqual([...CHANGES, "api.telegram.org is added to the hosts GoatCitadel may reach"]);
    expect(turnOnChanges({ senderName: "Ada", botUsername: "b", missingHosts: [] }).join("\n")).not.toContain(
      "hosts GoatCitadel may reach",
    );
  });

  it("gives each missing host its own line", () => {
    const lines = turnOnChanges({ senderName: "Ada", botUsername: "b", missingHosts: ["a.example", "b.example"] });
    expect(lines.slice(-2)).toEqual([
      "a.example is added to the hosts GoatCitadel may reach",
      "b.example is added to the hosts GoatCitadel may reach",
    ]);
  });
});

describe("TurnOnStep", () => {
  it("lists each change as an item, with a Turn on button", async () => {
    const onTurnOn = vi.fn();
    await show(turnOnState(), { onTurnOn });
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual(CHANGES);
    await act(async () => {
      button("Turn on")!.click();
    });
    expect(onTurnOn).toHaveBeenCalledTimes(1);
  });

  it("shows the host line when a host is missing, and leaves it out when none is", async () => {
    await show(turnOnState(), {
      changes: turnOnChanges({ senderName: "Ada", botUsername: "b", missingHosts: ["api.telegram.org"] }),
    });
    expect(container.textContent).toContain("api.telegram.org is added to the hosts GoatCitadel may reach");
    await show(turnOnState(), {
      changes: turnOnChanges({ senderName: "Ada", botUsername: "b", missingHosts: [] }),
    });
    expect(container.textContent).not.toContain("hosts GoatCitadel may reach");
  });

  it("says Turning on… and ignores clicks while it works", async () => {
    const onTurnOn = vi.fn();
    await show(turnOnState({ state: "working" }), { onTurnOn });
    const working = button("Turning on…")!;
    expect(working).toBeDefined();
    expect(working.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      working.click();
    });
    expect(onTurnOn).not.toHaveBeenCalled();
  });

  it("can be switched off, for the moment the page is not ready", async () => {
    const onTurnOn = vi.fn();
    await show(turnOnState(), { onTurnOn, disabled: true });
    expect(button("Turn on")!.disabled).toBe(true);
  });

  it("says it is on, and links to the channel's page", async () => {
    await show(turnOnState({ state: "done" }), { doneHref: "/chat/messaging/conn-2" });
    expect(container.textContent).toContain("Telegram is on. Send your bot a message to try it.");
    expect(link("Open Telegram's page")?.getAttribute("href")).toContain("/chat/messaging/conn-2");
    // What was going to happen has happened: no list, no button.
    expect(container.querySelector("li")).toBeNull();
    expect(button("Turn on")).toBeUndefined();
  });

  it("says it is on without a link when the channel's page could not be found", async () => {
    await show(turnOnState({ state: "done" }));
    expect(container.textContent).toContain("Telegram is on. Send your bot a message to try it.");
    expect(container.querySelector("a")).toBeNull();
  });

  it("offers Continue when the test message could not be removed, and Continue goes on", async () => {
    const turnOn = turnOnState({ state: "cleanup" });
    await show(turnOn);
    expect(container.textContent).toContain(
      "GoatCitadel couldn't remove its test message. Delete it in Telegram if you like.",
    );
    // Turning on again would send another test message, so only Continue is offered.
    expect(button("Turn on")).toBeUndefined();
    await act(async () => {
      button("Continue")!.click();
    });
    expect(turnOn.acknowledgeCleanup).toHaveBeenCalledTimes(1);
  });

  it("lists the reasons it could not turn on, one to a line", async () => {
    await show(turnOnState({ state: "blocked", reasons: ["Add a chat.", "Check the key."] }));
    const lines = [...container.querySelectorAll('[data-tone="warning"] p')].map((line) => line.textContent);
    expect(lines).toEqual(["Add a chat.", "Check the key."]);
    expect(button("Turn on")).toBeDefined();
  });

  it("shows the message when it failed, and lets the operator try again", async () => {
    await show(turnOnState({ state: "failed", message: "Telegram said no." }));
    expect(container.querySelector('[data-tone="error"]')?.textContent).toContain("Telegram said no.");
    expect(button("Turn on")).toBeDefined();
  });

  it("sends the operator to the approval in Inbox when there is one", async () => {
    await show(turnOnState({ state: "elsewhere", approvalId: "approval-9" }));
    const approve = link("Approve it in Inbox");
    expect(approve).toBeDefined();
    const target = new URL(approve!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-9");
    expect(target.searchParams.get("workspaceId")).toBe("default");
    expect(link("Finish this in Settings")).toBeUndefined();
  });

  it("sends the operator to Settings when the next step is not an approval", async () => {
    await show(turnOnState({ state: "elsewhere" }));
    const settings = link("Finish this in Settings");
    expect(settings).toBeDefined();
    const target = new URL(settings!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/settings/connections");
    expect(target.searchParams.get("channel")).toBe("channel.telegram");
    expect(link("Approve it in Inbox")).toBeUndefined();
  });

  it("adds no live region of its own, in any state", async () => {
    const states: TurnOn[] = [
      turnOnState(),
      turnOnState({ state: "working" }),
      turnOnState({ state: "done" }),
      turnOnState({ state: "cleanup" }),
      turnOnState({ state: "blocked", reasons: ["Add a chat."] }),
      turnOnState({ state: "failed", message: "No." }),
      turnOnState({ state: "elsewhere", approvalId: "a" }),
    ];
    for (const state of states) {
      await show(state);
      expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]'), state.state).toHaveLength(0);
    }
  });
});
