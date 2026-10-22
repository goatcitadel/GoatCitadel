import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EffectivePermissionContexts } from "./EffectivePermissionContexts";

const preferences = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => preferences,
}));

const RAW = "TypeError: Cannot read properties of undefined (reading 'items') at C:\\goat\\dist\\run.js:12";
let view: ReactTestRenderer | undefined;
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");

async function render(error: string) {
  await act(async () => {
    view = create(<EffectivePermissionContexts contexts={[{ surface: "chat", error }]} refreshing={false} />);
  });
  return text(view!.root);
}

beforeEach(() => {
  preferences.showTechnicalDetails = false;
});
afterEach(async () => {
  await act(async () => view?.unmount());
  view = undefined;
});

describe("EffectivePermissionContexts", () => {
  it("presents a technical context error as one plain line and keeps the recorded text out of view", async () => {
    const shown = await render(RAW);
    expect(shown).toContain("Unavailable: The recorded error isn't in a readable form.");
    expect(shown).not.toContain("TypeError");
  });

  it("keeps the recorded error in technical details when they are shown", async () => {
    preferences.showTechnicalDetails = true;
    await render(RAW);
    expect(view!.root.findAllByType("details").map(text).join(" ")).toContain(RAW);
  });

  it("passes a plain sentence through unchanged", async () => {
    const shown = await render("MCP owner unavailable");
    expect(shown).toContain("Unavailable: MCP owner unavailable");
    expect(view!.root.findAllByType("details")).toHaveLength(1); // only the legacy-contexts disclosure
  });
});
