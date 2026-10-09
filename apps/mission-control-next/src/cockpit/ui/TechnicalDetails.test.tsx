// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TechnicalDetails } from "./TechnicalDetails";
const prefs = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
function Review() {
  const [accepted, setAccepted] = useState(false);
  return <><p>Target /workspace/record-42 · Scope current workspace · Expires tomorrow · Deletes file</p>
    <p>Provenance current persisted record; outcome uncertain</p>
    <button type="button" onClick={() => setAccepted(true)}>{accepted ? "Reviewed" : "Review"}</button>
    <TechnicalDetails><p>Revision 7 · raw event JSON</p></TechnicalDetails></>;
}
it("controls secondary payloads without resetting mounted review or removing decision evidence", () => {
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container);
  try {
    prefs.showTechnicalDetails = false; act(() => root.render(<Review />));
    expect(container.textContent).not.toContain("Revision 7");
    act(() => container.querySelector("button")!.click());
    prefs.showTechnicalDetails = true; act(() => root.render(<Review />));
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("summary")?.textContent).toBe("Technical details");
    expect(container.textContent).toContain("Revision 7");
    prefs.showTechnicalDetails = false; act(() => root.render(<Review />));
    expect(container.textContent).toContain("Reviewed");
    expect(container.textContent).toContain("Target /workspace/record-42");
    expect(container.textContent).toContain("outcome uncertain");
  } finally { act(() => root.unmount()); container.remove(); prefs.showTechnicalDetails = false; }
});
