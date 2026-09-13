// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedSidebarProvider } from "../app/UnifiedSidebar";
import { DetailInspector } from "./DetailInspector";
import { useSessionDraft, __resetSessionDraftsForTests } from "../features/native-routes/library/session-drafts";
import { useDraftLeave } from "../features/native-routes/library/DraftLeaveDialog";
import { __resetFormDirtyRegistryForTests } from "../features/native-routes/library/use-form-dirty";
vi.mock("@goatcitadel/mission-control-shared/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
let root: ReturnType<typeof createRoot>;
function Editors() {
  const [record, setRecord] = useState(false), [system, setSystem] = useState(false);
  const leave = useDraftLeave();
  const draft = useSessionDraft("coordinated:record", "Canonical", 1, { label: "Record editor", active: record });
  return <>
    <button type="button" onClick={() => setRecord(true)}>Open record{draft.isDirty ? " · Unsaved" : ""}</button>
    <button type="button" onClick={() => setSystem(true)}>Open system</button>
    <DetailInspector open={record} title="Record editor" onClose={() => leave.request(() => setRecord(false), [draft.key])}>
      <input aria-label="Record input" value={draft.value} onChange={e => draft.setValue(e.target.value)} />
    </DetailInspector>
    <DetailInspector open={system} title="System details" onClose={() => setSystem(false)}>System evidence</DetailInspector>
    {leave.dialog}
  </>;
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(e => e.textContent === label || e.getAttribute("aria-label") === label);
  if (!button) throw new Error("Missing button " + label);
  await act(async () => button.click());
}
beforeEach(async () => {
  __resetSessionDraftsForTests(); __resetFormDirtyRegistryForTests();
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<UnifiedSidebarProvider mobile={false} navOpen={false} openNav={() => {}} closeNav={() => {}}><Editors /></UnifiedSidebarProvider>));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
describe("exclusive inspector coordination", () => {
  it("closes the preceding panel and does not reopen it when the new panel closes", async () => {
    await click("Open record"); await click("Open system");
    expect(document.querySelectorAll(".mc-next-detail-inspector")).toHaveLength(1);
    expect(document.querySelector(".mc-next-detail-inspector h2")?.textContent).toBe("System details");
    await click("Close details");
    expect(document.querySelectorAll(".mc-next-detail-inspector")).toHaveLength(0);
  });
  it("cancels a dirty switch, then keeps the draft through an accepted switch", async () => {
    await click("Open record");
    const input = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Retained input");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Open system");
    expect(document.querySelector(".mc-next-detail-inspector h2")?.textContent).toBe("Record editor");
    await click("Cancel");
    expect(document.querySelector("input")?.value).toBe("Retained input");
    await click("Open system"); await click("Keep draft and close");
    expect(document.querySelectorAll(".mc-next-detail-inspector")).toHaveLength(1);
    expect(document.querySelector(".mc-next-detail-inspector h2")?.textContent).toBe("System details");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click("Close details"); await click("Open record · Unsaved");
    expect(document.querySelector("input")?.value).toBe("Retained input");
  });
});

it("returns to the latest record opener when switching within a desktop inspector", async () => {
  function RecordPicker() {
    const [selected, setSelected] = useState("");
    return <><button type="button" onClick={() => setSelected("A")}>Record A</button><button type="button" onClick={() => setSelected("B")}>Record B</button>
      <DetailInspector open={Boolean(selected)} title={selected} onClose={() => setSelected("")}>Evidence</DetailInspector></>;
  }
  await act(async () => root.render(<RecordPicker />));
  const buttons = [...document.querySelectorAll("button")];
  await act(async () => { buttons[0]!.focus(); buttons[0]!.click(); });
  await act(async () => { buttons[1]!.focus(); buttons[1]!.click(); });
  expect(document.querySelector(".mc-next-detail-inspector h2")?.textContent).toBe("B");
  await click("Close details");
  expect(document.activeElement).toBe(buttons[1]);
});

it("returns focus to a connected opener when an open inspector unmounts", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  await act(async () => root.render(
    <DetailInspector open title="Temporary details" onClose={() => {}}>Evidence</DetailInspector>,
  ));
  expect(document.activeElement).toBe(document.querySelector(".mc-next-detail-inspector h2"));
  await act(async () => root.render(null));
  expect(document.activeElement).toBe(opener);
});
