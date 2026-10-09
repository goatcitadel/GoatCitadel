// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExternalSourceStrip } from "./ThreadedExternalSourceStrip";
import type { ComponentProps } from "react";
type Controls = ComponentProps<typeof ExternalSourceStrip>["controls"];
let root: Root, container: HTMLDivElement, controls: Controls;
beforeEach(() => {
 container = document.createElement("div"); document.body.append(container); root = createRoot(container);
 controls = { attachments: [{ attachmentId: "attachment-a", sourceId: "source-a", importId: "import-a", itemId: "item-a", revision: 1, attachedAt: "2026-10-01T00:00:00Z", normalizedArtifactSha256: "a".repeat(64) }], candidates: [{ sourceId: "source-a", importId: "import-a", itemId: "item-a", sourceLabel: "Owned source", importedAt: "2026-10-01T00:00:00Z", artifactsVerifiedAt: "2026-10-01T00:00:00Z" }], selectedAttachmentIds: [], busyAttachmentId: null, loading: false, canMutate: true, onToggleSelect: vi.fn(), onClearSelection: vi.fn(), onAttach: vi.fn(), onReload: vi.fn(), onDetach: vi.fn(), onRequestKnowledgeSnapshot: vi.fn() } as unknown as Controls;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<ExternalSourceStrip controls={controls} disabled={false} />)); }
async function click(name: string) { const b = [...container.querySelectorAll<HTMLButtonElement>("button")].find(n => (n.getAttribute("aria-label") ?? n.textContent?.trim()) === name)!; expect(b).toBeTruthy(); await act(async () => b.click()); }
it("explains unavailable next-turn selection while preserving the actual attachment actions", async () => {
 await render(); expect(container.textContent).toContain("New Chat turns use live capabilities"); await click("Choose sources");
 const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Include Owned source in the next turn"]')!;
 expect(checkbox.disabled).toBe(true); expect(document.getElementById(checkbox.getAttribute("aria-describedby")!)?.textContent).toContain("temporarily unavailable"); await act(async () => checkbox.click()); expect(controls.onToggleSelect).not.toHaveBeenCalled();
 expect(container.textContent).toContain("Item item-a"); await click("Request a governed knowledge copy of this source"); expect(controls.onRequestKnowledgeSnapshot).toHaveBeenCalledExactlyOnceWith("attachment-a"); await click("Detach this read-only source"); expect(controls.onDetach).toHaveBeenCalledExactlyOnceWith("attachment-a"); await click("Attach verified import from Owned source read-only"); expect(controls.onAttach).toHaveBeenCalledExactlyOnceWith({ sourceId: "source-a", importId: "import-a", itemId: "item-a" }); await click("Done reviewing sources"); expect(container.querySelector('[role="dialog"]')).toBeNull();
});
it.each([false, true])("keeps the exact unavailable-context notice once, compact on phone (phone=%s)", async (phone) => {
 const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({ matches: phone && query === "(max-width: 639px)", media: query, onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() }) as unknown as MediaQueryList);
 await render();
 const notice = "New Chat turns use live capabilities, so including external sources in the next turn is temporarily unavailable. Attaching a source does not include it in model context.";
 const holders = [...container.querySelectorAll("p")].filter(p => p.textContent === notice);
 expect(holders).toHaveLength(1);
 const disclosure = holders[0]!.closest("details");
 if (phone) {
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("New-turn context unavailable");
  expect(disclosure?.querySelector("summary")?.textContent).toBe("About read-only sources");
  expect(disclosure?.open).toBe(false);
 } else {
  expect(disclosure).toBeNull();
  expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe("Attached sources remain available for inspection and governed Knowledge copies.");
 }
 expect([...container.querySelectorAll("button")].some(b => b.textContent === "Choose sources")).toBe(true);
 matchMedia.mockRestore();
});
it("preserves retained intent for explicit clearing instead of claiming it will be sent", async () => {
 controls.selectedAttachmentIds = ["attachment-a"]; await render(); expect(container.textContent).toContain("Clear the selection to send"); expect(controls.onClearSelection).not.toHaveBeenCalled(); await click("Choose sources"); const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!; expect(checkbox.checked).toBe(true); expect(checkbox.disabled).toBe(false); await act(async () => checkbox.click()); expect(controls.onToggleSelect).toHaveBeenCalledExactlyOnceWith("attachment-a"); await click("Close"); await click("Clear the external source selection"); expect(controls.onClearSelection).toHaveBeenCalledTimes(1);
});
