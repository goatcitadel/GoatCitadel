// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TechnicalDetails } from "./TechnicalDetails";
const { prefs, play } = vi.hoisted(() => ({ prefs: { showTechnicalDetails: false }, play: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
vi.mock("./use-control-wave", () => ({ useControlWave: () => ({ play }), warmControlWave: vi.fn() }));
function Review() {
  const [accepted, setAccepted] = useState(false);
  return (
    <>
      <p>Target /workspace/record-42 · Scope current workspace · Expires tomorrow · Deletes file</p>
      <p>Provenance current persisted record; outcome uncertain</p>
      <button type="button" onClick={() => setAccepted(true)}>
        {accepted ? "Reviewed" : "Review"}
      </button>
      <TechnicalDetails>
        <p>Revision 7 · raw event JSON</p>
      </TechnicalDetails>
    </>
  );
}
it("controls secondary payloads without resetting mounted review or removing decision evidence", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    prefs.showTechnicalDetails = false;
    act(() => root.render(<Review />));
    expect(container.textContent).not.toContain("Revision 7");
    act(() => container.querySelector("button")!.click());
    prefs.showTechnicalDetails = true;
    act(() => root.render(<Review />));
    expect(container.querySelector("details")?.open).toBe(false);
    const summary = container.querySelector("summary")!;
    expect(summary.textContent).toBe("Technical details");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => summary.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(false);
    expect(play).toHaveBeenCalledExactlyOnceWith(summary, summary, click, { preserveText: true });
    expect(container.textContent).toContain("Revision 7");
    prefs.showTechnicalDetails = false;
    act(() => root.render(<Review />));
    expect(container.textContent).toContain("Reviewed");
    expect(container.textContent).toContain("Target /workspace/record-42");
    expect(container.textContent).toContain("outcome uncertain");
  } finally {
    act(() => root.unmount());
    container.remove();
    prefs.showTechnicalDetails = false;
  }
});
