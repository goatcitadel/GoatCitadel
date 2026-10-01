import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function assertWorkDraftFields(actual, expected) {
  assert.deepEqual(actual, expected, "Unsent form fields must match the exact retained or discarded draft.");
}

export function assertWorkDraftTransition({ before, after, targetUrl, decision }) {
  assert.ok(["cancel", "keep", "discard"].includes(decision));
  assert.equal(new URL(targetUrl).origin, new URL(before.url).origin, "Draft navigation changed installation origin.");
  assert.equal(after.url, decision === "cancel" ? before.url : targetUrl, "Draft decision selected a different URL.");
  assert.equal(after.writes, before.writes, "A draft leave decision dispatched a runtime write.");
  assert.equal(after.documents, before.documents, "A draft leave decision loaded another document.");
  assert.equal(after.timeOrigin, before.timeOrigin, "A draft leave decision lost the browser document.");
  assert.equal(after.marker, before.marker, "A draft leave decision lost its document realm marker.");
  assert.equal(after.sameRoot, true, "A draft leave decision remounted the application root.");
  assert.deepEqual(after.selection, before.selection, "A draft leave decision changed Citadel/workspace selection.");
}

async function readFields(form, fields) {
  await form.waitFor({ state: "visible" });
  const values = {};
  for (const field of fields) {
    const control = form.getByRole(field.select ? "combobox" : "textbox", { name: field.label, exact: true });
    assert.equal(await control.count(), 1, "Draft proof requires one exact labeled input: " + field.label);
    assert.equal(await control.isVisible(), true);
    assert.equal(await control.isDisabled(), false);
    values[field.label] = await control.inputValue();
  }
  return values;
}

async function leaveDialog(page, label) {
  const dialog = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await dialog.waitFor();
  assert.equal(await dialog.count(), 1, "A leave decision must bind one visible draft dialog.");
  assert.ok((await dialog.innerText()).includes(label), "The leave dialog omitted its actual dirty form owner.");
  return dialog;
}

/** Existing unknown-outcome stages retain their input; this never discards a lock or draft. */
export async function keepWorkDraftOnLeave({ page, action, label }) {
  await action();
  const dialog = await leaveDialog(page, label);
  await dialog.getByRole("button", { name: "Keep draft and close", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
}

/** Actual unsent controls, explicit operator decisions, and browser Back only.
 * Runtime receipts and unknown/conflict assertions remain in the lifecycle owners. */
export async function runWorkDraftLeaveProof({
  page, form, fields, clearedFields, label, destinationLink, destinationPath,
  reopen, destinationReady, selection, writes, documentCount, capture,
}) {
  assertWorkDraftFields(await readFields(form, fields), clearedFields);
  for (const field of fields) {
    const control = form.getByRole(field.select ? "combobox" : "textbox", { name: field.label, exact: true });
    if (field.select) await control.selectOption(field.value);
    else await control.fill(field.value);
  }
  const retainedFields = Object.fromEntries(fields.map(field => [field.label, field.value]));
  assertWorkDraftFields(await readFields(form, fields), retainedFields);
  const marker = randomUUID();
  await page.evaluate(value => {
    window.__workDraftProofMarker = value;
    window.__workDraftProofRoot = document.getElementById("root");
  }, marker);
  const snapshot = async () => ({
    url: page.url(), writes: writes.length, documents: documentCount(), selection: await selection(),
    ...await page.evaluate(() => ({
      timeOrigin: performance.timeOrigin,
      marker: window.__workDraftProofMarker,
      sameRoot: window.__workDraftProofRoot === document.getElementById("root"),
    })),
  });
  const before = await snapshot(), targetUrl = new URL(destinationPath, before.url).href;
  const begin = async () => {
    // Inspect every accessible field before the leave modal hides the underlying owner form.
    assertWorkDraftFields(await readFields(form, fields), retainedFields);
    await destinationLink.click();
    const dialog = await leaveDialog(page, label);
    assertWorkDraftTransition({ before, after: await snapshot(), targetUrl, decision: "cancel" });
    return dialog;
  };
  await capture("draft-input", form);

  let dialog = await begin();
  await capture("draft-leave-review", dialog);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assertWorkDraftTransition({ before, after: await snapshot(), targetUrl, decision: "cancel" });
  assertWorkDraftFields(await readFields(form, fields), retainedFields);

  dialog = await begin();
  await dialog.getByRole("button", { name: "Keep draft and close", exact: true }).click();
  await page.waitForURL(targetUrl);
  await dialog.waitFor({ state: "hidden" });
  await destinationReady();
  assertWorkDraftTransition({ before, after: await snapshot(), targetUrl, decision: "keep" });
  await page.goBack();
  await page.waitForURL(before.url);
  await reopen();
  assertWorkDraftFields(await readFields(form, fields), retainedFields);
  assertWorkDraftTransition({ before, after: await snapshot(), targetUrl, decision: "cancel" });
  await capture("draft-retained", form);

  dialog = await begin();
  await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
  await page.waitForURL(targetUrl);
  await dialog.waitFor({ state: "hidden" });
  await destinationReady();
  assertWorkDraftTransition({ before, after: await snapshot(), targetUrl, decision: "discard" });
  await page.goBack();
  await page.waitForURL(before.url);
  await reopen();
  assertWorkDraftFields(await readFields(form, fields), clearedFields);
  assertWorkDraftTransition({ before, after: await snapshot(), targetUrl, decision: "cancel" });
  await capture("draft-discarded", form);
  return { cancelRetainsUrlAndInput: true, keepRetainsInputAcrossBack: true,
    discardClearsExactFields: true, draftDecisionWrites: 0, sameDocumentDraftNavigation: true };
}
