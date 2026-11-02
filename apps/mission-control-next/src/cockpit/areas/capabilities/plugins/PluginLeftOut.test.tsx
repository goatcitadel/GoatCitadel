// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CapabilityPluginIgnoredPart } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginLeftOut } from "./PluginLeftOut";

const prefs = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));

const PARTS: CapabilityPluginIgnoredPart[] = [
  { kind: "hook", label: "PreToolUse", path: "hooks/hooks.json", reason: "Hooks run programs." },
  { kind: "agent", label: "reviewer", path: "agents/reviewer.md", reason: "Subagents run only in Claude Code." },
];

let container: HTMLDivElement;
let root: Root;

async function render(ignored: CapabilityPluginIgnoredPart[] | undefined) {
  await act(async () => root.render(<PluginLeftOut ignored={ignored} />));
}

beforeEach(() => {
  prefs.showTechnicalDetails = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("What it leaves out", () => {
  it("groups the parts by kind in a fixed order, each with its reason", async () => {
    await render(PARTS);
    expect(container.querySelector("h3")?.textContent).toBe("What it leaves out");
    expect([...container.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual([
      "Subagents 1",
      "Hooks 1",
    ]);
    expect(container.textContent).toContain("Subagents run only in Claude Code.");
    expect(container.textContent).not.toContain("hooks/hooks.json");
  });

  it("shows paths only in Technical details", async () => {
    prefs.showTechnicalDetails = true;
    await render(PARTS);
    expect(container.textContent).toContain("hook: hooks/hooks.json");
  });

  it("shows nothing when nothing was left out", async () => {
    await render([]);
    expect(container.textContent).toBe("");
    await render(undefined);
    expect(container.textContent).toBe("");
  });
});
