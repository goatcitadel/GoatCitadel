// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelAdvancedSetup } from "./ChannelAdvancedSetup";

const preferences = vi.hoisted(() => ({ activeWorkspaceId: "workspace-a" as string | undefined }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => preferences,
}));
// The editors moved here unchanged from Settings and have their own tests; this file covers the page around them.
vi.mock("../../settings/PublicWebAddressSettings", () => ({
  PublicWebAddressSettings: () => <p>Public web address owner</p>,
}));
vi.mock("../../settings/ChannelsSettings", () => ({
  ChannelsSettings: ({ workspaceId }: { workspaceId: string }) => <p>Channels owner {workspaceId || "(none)"}</p>,
}));

let root: Root;
let container: HTMLDivElement;

async function mount() {
  await act(async () => root.render(<ChannelAdvancedSetup />));
  await vi.waitFor(() => expect(container.textContent).toContain("Channels owner"));
}

beforeEach(() => {
  preferences.activeWorkspaceId = "workspace-a";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Chat › Messaging › Advanced channel setup", () => {
  it("names itself and links back to the channel picker", async () => {
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Advanced channel setup");
    const back = [...container.querySelectorAll("a")].find((link) => link.textContent === "Back to channels");
    expect(new URL(back!.href).pathname).toBe("/chat/messaging/add");
    // h1 › h2 › each part's h3, as the outline was in Settings.
    expect(container.querySelector("h2")?.textContent).toBe("Channels and the public web address");
  });

  it("puts the public web address above the channel setup that builds its addresses from it", async () => {
    await mount();
    const text = container.textContent ?? "";
    expect(text.indexOf("Public web address owner")).toBeGreaterThan(-1);
    expect(text.indexOf("Public web address owner")).toBeLessThan(text.indexOf("Channels owner"));
  });

  it("gives the channel editors the workspace Settings gave them, or none", async () => {
    await mount();
    expect(container.textContent).toContain("Channels owner workspace-a");
    act(() => root.unmount());
    root = createRoot(container);
    preferences.activeWorkspaceId = undefined;
    await mount();
    expect(container.textContent).toContain("Channels owner (none)");
  });
});
