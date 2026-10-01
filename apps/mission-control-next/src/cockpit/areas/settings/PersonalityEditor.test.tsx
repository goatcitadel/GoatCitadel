// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PersonalityCatalogMutationInput,
  PersonalityCatalogResponse,
  PersonalityPreset,
} from "@goatcitadel/contracts";
import type { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import type { Dialog } from "../../ui/Dialog";
import { __resetPersonalityDefaultForTests } from "../../../features/native-routes/settings/use-personality-default";
import { __resetPersonalityEditorMutationForTests } from "../../../features/native-routes/settings/personality-editor-mutation";
import { __resetSessionDraftsForTests } from "../../../features/native-routes/library/session-drafts";
import { __resetFormDirtyRegistryForTests } from "../../../features/native-routes/library/use-form-dirty";
import { PersonalitySettings } from "./PersonalitySettings";

const api = vi.hoisted(() => ({
  fetchPersonalities: vi.fn(),
  createPersonality: vi.fn(),
  updatePersonality: vi.fn(),
  deletePersonality: vi.fn(),
  setDefaultPersonality: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({
  ...api,
  isApiRequestError: (value: unknown) => Boolean(value && typeof value === "object" && "status" in value),
}));
const confirmations = new Map<string, ComponentProps<typeof ConfirmModal>>();
vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", () => ({
  ConfirmModal: (props: ComponentProps<typeof ConfirmModal>) => {
    confirmations.set(props.title, props);
    return null;
  },
}));
vi.mock("../../ui/Dialog", () => ({
  Dialog: (props: ComponentProps<typeof Dialog>) =>
    props.open ? (
      <section role="dialog" aria-label={props.title}>
        {props.children}
      </section>
    ) : null,
}));
const preset = (id: string): PersonalityPreset => ({
  id,
  label: id,
  category: "core",
  description: "Description",
  tone: "Direct",
  style: "Concise",
  systemOverlay: "Keep policy authoritative",
  safetyNotes: ["Policy wins"],
  soulFile: "",
  builtin: id !== "custom",
  visibility: id === "custom" ? "custom" : "builtin",
  editable: id !== "default",
  modified: id === "operator",
});
let owner: PersonalityCatalogResponse, root: Root, container: HTMLDivElement, revision: number;
const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent === label)!;
const editor = () => container.querySelector('[aria-label="Personality editor"]')!;
const field = (label: string) =>
  [...editor().querySelectorAll("label")]
    .find((item) => item.textContent?.startsWith(label))!
    .querySelector("input,textarea,select") as HTMLInputElement;
function advance(items: PersonalityPreset[]) {
  owner = { ...owner, items, revision: String(++revision).padStart(64, "0") };
  return owner;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(label: string, value: string) {
  await act(async () => {
    const input = field(label);
    const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(id: string) {
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Edit selected personality");
}
async function render() {
  await act(async () => root.render(<PersonalitySettings />));
  await vi.waitFor(() => expect(button("Add custom personality")?.disabled).toBe(false));
}
beforeEach(() => {
  vi.resetAllMocks();
  confirmations.clear();
  revision = 0;
  __resetPersonalityDefaultForTests();
  __resetPersonalityEditorMutationForTests();
  __resetSessionDraftsForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("Unexpected personality network"))),
  );
  owner = {
    revision: "a".repeat(64),
    defaultPersonalityId: "default",
    items: [preset("default"), preset("operator"), preset("custom")],
  };
  api.fetchPersonalities.mockImplementation(async () => owner);
  api.createPersonality.mockImplementation(async (input: PersonalityCatalogMutationInput) =>
    advance([...owner.items, { ...preset("custom"), ...input, id: input.id ?? "new", label: input.label ?? "New" }]),
  );
  api.updatePersonality.mockImplementation(async (id: string, input: PersonalityCatalogMutationInput) =>
    advance(owner.items.map((item) => (item.id === id ? { ...item, ...input } : item))),
  );
  api.deletePersonality.mockImplementation(async (id: string) =>
    advance(
      id === "operator"
        ? owner.items.map((item) => (item.id === id ? { ...item, modified: false } : item))
        : owner.items.filter((item) => item.id !== id),
    ),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetSessionDraftsForTests();
  __resetFormDirtyRegistryForTests();
  __resetPersonalityEditorMutationForTests();
  vi.unstubAllGlobals();
});

describe("native personality editor", () => {
  it("keeps exact accessible field names separate from populated textarea values and category options", async () => {
    await render();
    await choose("operator");
    for (const label of ["ID", "Label", "Tone", "Style", "Category", "Description", "System overlay", "Safety notes"]) {
      const input = field(label);
      const labelledBy = input.getAttribute("aria-labelledby");
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(labelledBy!)?.textContent).toBe(label);
    }
    expect(field("Safety notes").value).toBe("Policy wins");
    await fill("Safety notes", "Revised policy note");
    expect(document.getElementById(field("Safety notes").getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Safety notes",
    );
  });
  it("keeps and restores an unsaved native draft, then creates and edits against exact catalog revisions", async () => {
    await render();
    await click("Add custom personality");
    await fill("ID", "native-voice");
    await fill("Label", "Native voice");
    await click("Close editor");
    expect(container.querySelector('[aria-label="Unsaved changes"]')).not.toBeNull();
    await click("Keep draft and close");
    expect(editor()).toBeNull();
    expect(api.createPersonality).not.toHaveBeenCalled();
    await click("Add custom personality");
    expect(field("Label").value).toBe("Native voice");
    await click("Create personality");
    await vi.waitFor(() => expect(editor()).toBeNull());
    expect(api.createPersonality.mock.calls[0]![0]).toMatchObject({
      id: "native-voice",
      label: "Native voice",
      expectedRevision: "a".repeat(64),
    });
    const createdRevision = owner.revision;
    await choose("native-voice");
    await fill("Label", "Revised voice");
    await click("Save edits");
    await vi.waitFor(() => expect(editor().textContent).toContain("Native voice saved."));
    expect(api.updatePersonality).toHaveBeenCalledWith(
      "native-voice",
      expect.objectContaining({ label: "Revised voice", expectedRevision: createdRevision }),
    );
    expect(owner.defaultPersonalityId).toBe("default");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires explicit reset and removal review while keeping the default identity locked", async () => {
    await render();
    await choose("default");
    expect(field("Label").disabled).toBe(true);
    expect(button("Save edits").disabled).toBe(true);
    expect(button("Remove custom")).toBeUndefined();
    await click("Close editor");
    await choose("operator");
    expect(field("ID").disabled).toBe(true);
    await click("Reset built-in");
    let review = confirmations.get("Reset built-in personality?")!;
    expect(review.open).toBe(true);
    expect(review.message).toContain("shipped preset");
    expect(api.deletePersonality).not.toHaveBeenCalled();
    await act(async () => review.onCancel());
    expect(api.deletePersonality).not.toHaveBeenCalled();
    await click("Reset built-in");
    review = confirmations.get("Reset built-in personality?")!;
    await act(async () => review.onConfirm());
    expect(api.deletePersonality).toHaveBeenCalledWith("operator", "a".repeat(64));
    await choose("custom");
    const expectedRevision = owner.revision;
    await click("Remove custom");
    review = confirmations.get("Remove custom personality?")!;
    expect(review.danger).toBe(true);
    await act(async () => review.onConfirm());
    expect(api.deletePersonality).toHaveBeenLastCalledWith("custom", expectedRevision);
    expect(owner.items.some((item) => item.id === "custom")).toBe(false);
  });
  it("retains a failed dispatched draft and blocks all mutation buttons after an unknown outcome", async () => {
    api.updatePersonality.mockRejectedValue(new Error("Lost reply"));
    await render();
    await choose("custom");
    await fill("Label", "Retained draft");
    await click("Save edits");
    await vi.waitFor(() => expect(editor().textContent).toContain("Outcome uncertain"));
    expect(field("Label").value).toBe("Retained draft");
    expect(button("Save edits").disabled).toBe(true);
    expect(button("Remove custom").disabled).toBe(true);
    expect(button("Add custom personality").disabled).toBe(true);
    expect(api.updatePersonality).toHaveBeenCalledOnce();
  });
});
