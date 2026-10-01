import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function assertPersonalityEditorReceipt({ before, after, response, request, id, fields, removed = false }) {
  assert.match(before.revision, /^[a-f0-9]{64}$/u);
  assert.match(after.revision, /^[a-f0-9]{64}$/u);
  assert.notEqual(after.revision, before.revision, "The edited owner catalog did not advance.");
  assert.equal(request.expectedRevision, before.revision, "The edit used another catalog revision.");
  assert.equal(after.defaultPersonalityId, before.defaultPersonalityId, "Editing the fixture changed the global default.");
  assert.deepEqual(response, after, "The edit receipt disagrees with canonical owner readback.");
  const saved = after.items.find((item) => item.id === id);
  if (removed) assert.equal(saved, undefined, "The removed personality remains in the owner catalog.");
  else {
    assert.ok(saved, "The edited personality is absent from the owner catalog.");
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(saved[key], value, `Saved personality ${key} differs from the reviewed draft.`);
  }
}

/** Only disposable catalog fixtures are changed; no model turns or session preferences are involved. */
export async function runPersonalityEditorJourney({ page, panel, readCatalog, api, audit }) {
  const id = `verification-${randomUUID().slice(0, 12)}`;
  const label = `Verification voice ${id.slice(-4)}`;
  const fields = { id, label, description: "Disposable native editor proof", category: "execution", tone: "Direct",
    style: "Concise", systemOverlay: "Use concise evidence. Policy remains authoritative.", safetyNotes: ["Keep approvals authoritative", "Do not infer permission"] };
  const initial = await readCatalog();
  const builtin = initial.items.find((item) => item.builtin && item.editable !== false && item.id !== "default" && !item.modified && item.id !== initial.defaultPersonalityId);
  assert.ok(builtin, "The isolated owner must advertise an unmodified editable built-in for reset proof.");
  let builtinModified = false;
  const select = panel.getByRole("combobox", { name: "Saved personality", exact: true });
  const editDialog = () => page.getByRole("dialog", { name: "Edit saved personality", exact: true });
  const open = async (personalityId) => {
    await select.selectOption(personalityId);
    await panel.getByRole("button", { name: "Edit selected personality", exact: true }).click();
    await editDialog().waitFor();
  };
  const mutate = async (method, route, click, expectedFields, personalityId, removed = false) => {
    const before = await readCatalog();
    const waiting = page.waitForResponse((response) => response.request().method() === method && new URL(response.url()).pathname === route);
    await click();
    const response = await waiting;
    assert.equal(response.status(), method === "POST" ? 201 : 200, `Personality ${method} did not complete.`);
    const after = await readCatalog();
    assertPersonalityEditorReceipt({ before, after, request: response.request().postDataJSON(), response: await response.json(),
      id: personalityId, fields: expectedFields, removed });
    return after;
  };
  try {
    await panel.getByRole("button", { name: "Add custom personality", exact: true }).click();
    const create = page.getByRole("dialog", { name: "New custom personality", exact: true });
    await create.waitFor();
    for (const [name, value] of Object.entries({ ID: id, Label: label, Description: fields.description,
      Tone: fields.tone, Style: fields.style, "System overlay": fields.systemOverlay, "Safety notes": fields.safetyNotes.join("\n") })) {
      await create.getByLabel(name, { exact: true }).fill(value);
    }
    await create.getByLabel("Category", { exact: true }).selectOption(fields.category);
    assert.equal((await readCatalog()).revision, initial.revision, "Typing the personality draft changed the owner.");
    await audit("editor-draft");
    await create.getByRole("button", { name: "Close editor", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
    await leave.waitFor();
    await leave.getByRole("button", { name: "Keep draft and close", exact: true }).click();
    await create.waitFor({ state: "hidden" });
    await panel.getByRole("button", { name: "Add custom personality", exact: true }).click();
    await create.waitFor();
    assert.equal(await create.getByLabel("Label", { exact: true }).inputValue(), label);
    await mutate("POST", "/api/v1/personalities", () => create.getByRole("button", { name: "Create personality", exact: true }).click(),
      { ...fields, builtin: false }, id);
    await create.waitFor({ state: "hidden" });
    await open(id);
    const editedLabel = `${label} revised`;
    await editDialog().getByLabel("Label", { exact: true }).fill(editedLabel);
    await mutate("PATCH", `/api/v1/personalities/${id}`, () => editDialog().getByRole("button", { name: "Save edits", exact: true }).click(),
      { ...fields, label: editedLabel, builtin: false }, id);
    await editDialog().getByText(`${label} saved.`, { exact: true }).waitFor();
    await audit("editor-saved");
    await editDialog().getByRole("button", { name: "Close editor", exact: true }).click();
    await editDialog().waitFor({ state: "hidden" });
    await open("default");
    assert.equal(await editDialog().getByLabel("Label", { exact: true }).isDisabled(), true);
    assert.equal(await editDialog().getByRole("button", { name: "Save edits", exact: true }).isDisabled(), true);
    await editDialog().getByRole("button", { name: "Close editor", exact: true }).click();
    await open(builtin.id);
    assert.equal(await editDialog().getByLabel("ID", { exact: true }).isDisabled(), true);
    const override = `${builtin.label} verification override`;
    await editDialog().getByLabel("Label", { exact: true }).fill(override);
    // Mark before dispatch so cleanup inspects the owner even if response evidence fails.
    builtinModified = true;
    await mutate("PATCH", `/api/v1/personalities/${encodeURIComponent(builtin.id)}`,
      () => editDialog().getByRole("button", { name: "Save edits", exact: true }).click(), { label: override, builtin: true, modified: true }, builtin.id);
    await editDialog().getByText(`${builtin.label} saved.`, { exact: true }).waitFor();
    await editDialog().getByRole("button", { name: "Reset built-in", exact: true }).click();
    const reset = page.getByRole("dialog", { name: "Reset built-in personality?", exact: true });
    await reset.waitFor();
    const beforeReset = await readCatalog();
    await reset.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal((await readCatalog()).revision, beforeReset.revision, "Cancelling reset mutated the personality.");
    await editDialog().getByRole("button", { name: "Reset built-in", exact: true }).click();
    await mutate("DELETE", `/api/v1/personalities/${encodeURIComponent(builtin.id)}`,
      () => reset.getByRole("button", { name: "Reset personality", exact: true }).click(), builtin, builtin.id);
    builtinModified = false;
    await editDialog().waitFor({ state: "hidden" });
    await open(id);
    await editDialog().getByRole("button", { name: "Remove custom", exact: true }).click();
    const remove = page.getByRole("dialog", { name: "Remove custom personality?", exact: true });
    await remove.waitFor();
    await audit("editor-remove-review");
    await mutate("DELETE", `/api/v1/personalities/${id}`,
      () => remove.getByRole("button", { name: "Remove personality", exact: true }).click(), {}, id, true);
    await editDialog().waitFor({ state: "hidden" });
    return { customCreateEditRemove: true, retainedDraft: true, lockedDefault: true, builtinOverrideReset: true, editorMutations: 5 };
  } finally {
    let current = await readCatalog();
    if (current.items.some((item) => item.id === id)) {
      await api(`/api/v1/personalities/${id}`, { method: "DELETE", body: { expectedRevision: current.revision } });
      current = await readCatalog();
    }
    if (builtinModified && current.items.some((item) => item.id === builtin.id && item.modified)) {
      await api(`/api/v1/personalities/${encodeURIComponent(builtin.id)}`, { method: "DELETE", body: { expectedRevision: current.revision } });
    }
  }
}
