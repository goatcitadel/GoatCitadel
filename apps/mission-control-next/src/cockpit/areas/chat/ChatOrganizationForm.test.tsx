// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatOrganizationForm } from "./ChatOrganizationForm";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Dock = Parameters<typeof ChatOrganizationForm>[0]["dock"];
function dock(overrides: Partial<Dock> = {}): Dock {
  return {
    folderName: "Research",
    tagsValue: "alpha, beta",
    onFolderNameChange: vi.fn(),
    onTagsValueChange: vi.fn(),
    onSaveOrganization: vi.fn().mockResolvedValue(undefined),
    sessionControlPending: null,
    selectedSession: { sessionId: "s", folderName: "", tags: [] },
    ...overrides,
  } as unknown as Dock;
}
const render = (value: Dock) => act(async () => root.render(<ChatOrganizationForm dock={value} />));
const save = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const status = () => container.querySelector('[role="status"]')?.textContent;

it("labels both fields, shows saving, then confirms what the saved conversation holds (CH-24)", async () => {
  const value = dock();
  await render(value);
  expect(container.querySelector("label")?.textContent).toBe("Folder");
  expect(save().textContent).toBe("Save folder and tags");
  await act(async () => save().click());
  expect(value.onSaveOrganization).toHaveBeenCalledTimes(1);
  await render({ ...value, sessionControlPending: "organization" });
  expect(save().getAttribute("aria-busy")).toBe("true");
  expect(save().textContent).toBe("Saving…");
  await render({
    ...value,
    selectedSession: { sessionId: "s", folderName: "Research", tags: ["alpha", "beta"] } as never,
  });
  expect(status()).toBe("Folder and tags saved.");
});

it("reports a save that did not land and clears the outcome when the draft changes (CH-24)", async () => {
  const value = dock();
  await render(value);
  await act(async () => save().click());
  expect(status()).toBe("Folder and tags weren’t saved. The reason is shown in the conversation; try again.");
  const folder = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(folder, "Other");
    folder.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(status()).toBe("");
});

it("reports a save outcome from the save result, not a draft comparison", async () => {
  // The saved conversation already matches the draft, yet the save itself failed: the form says so.
  const matching = { sessionId: "s", folderName: "Research", tags: ["alpha", "beta"] } as never;
  const failed = dock({ selectedSession: matching, onSaveOrganization: vi.fn().mockResolvedValue(false) });
  await render(failed);
  await act(async () => save().click());
  expect(status()).toBe("Folder and tags weren’t saved. The reason is shown in the conversation; try again.");
  // The saved conversation does not match the draft yet (the list has not refreshed), but the save succeeded.
  const saved = dock({ onSaveOrganization: vi.fn().mockResolvedValue(true) });
  await render(saved);
  await act(async () => save().click());
  expect(status()).toBe("Folder and tags saved.");
  // A rejected save is a failure whatever the draft holds.
  const rejected = dock({ selectedSession: matching, onSaveOrganization: vi.fn().mockRejectedValue(new Error("no")) });
  await render(rejected);
  await act(async () => save().click());
  expect(status()).toBe("Folder and tags weren’t saved. The reason is shown in the conversation; try again.");
});

it("keeps both fields read-only while the save is pending, so the outcome matches what was saved", async () => {
  await render(dock({ sessionControlPending: "organization" }));
  const inputs = [...container.querySelectorAll("input")];
  expect(inputs).toHaveLength(2);
  for (const input of inputs) expect(input.readOnly).toBe(true);
  await render(dock());
  for (const input of container.querySelectorAll("input")) expect(input.readOnly).toBe(false);
});

it("uses 16px text on phones so iOS does not zoom the fields", async () => {
  await render(dock());
  for (const input of container.querySelectorAll("input")) expect(input.className).toMatch(/(?:^|\s)text-md(?:\s|$)/);
});
