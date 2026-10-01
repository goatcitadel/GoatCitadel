import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function assertNavigationDraftOwner({ before, after, writes, origin, current, retained, expected }) {
  assert.deepEqual(after, before, "Presentation navigation changed the canonical tool-grant owner.");
  assert.deepEqual(writes, [], "Draft navigation dispatched a tool-grant mutation.");
  assert.equal(current, origin, "Draft navigation replaced its browser document.");
  assert.equal(retained, expected, "Navigation lost the exact unsaved grant text.");
}

export async function fillNavigationGrantDraft(page) {
  const panel = page.getByRole("region", { name: "Tool catalog and grants", exact: true });
  const field = panel.getByRole("textbox", { name: "Tool pattern", exact: true });
  await field.waitFor({ timeout: 30_000 });
  const value = `cockpit_navigation_no_such_tool_${randomUUID().replaceAll("-", "")}`;
  await field.fill(value);
  await panel.getByRole("combobox", { name: "Decision", exact: true }).selectOption("deny");
  await panel.getByRole("heading", { name: "New grant · Unsaved", exact: true }).waitFor();
  return { field, value };
}

export async function reviewNavigationDraft(page, trigger, decision) {
  const priorUrl = page.url();
  await trigger();
  const dialog = page.getByRole("dialog", { name: "Unsaved changes", exact: true });
  await dialog.waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).count(), 1);
  assert.equal(page.url(), priorUrl, "Navigation happened before the leave decision.");
  await dialog.getByText("You have unsaved changes in Tool grant.", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: decision, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  if (decision === "Cancel") assert.equal(page.url(), priorUrl, "Canceled navigation changed its URL.");
}

/** Real text-only draft, exact canonical owner unchanged, and same-document Back restoration. */
export async function proveCatalogDraftNavigation({ page, readGrants }) {
  const before = await readGrants(), writes = [];
  const record = (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/v1/tools/grants")) {
      writes.push({ method: request.method(), pathname: new URL(request.url()).pathname });
    }
  };
  page.on("request", record);
  try {
    const origin = await page.evaluate(() => performance.timeOrigin), sourceUrl = page.url();
    const { field, value } = await fillNavigationGrantDraft(page);
    const trigger = () => page.getByRole("link", { name: "Inspect tools", exact: true }).click();
    await reviewNavigationDraft(page, trigger, "Cancel");
    assert.equal(await field.inputValue(), value); assert.deepEqual(writes, []);
    await reviewNavigationDraft(page, trigger, "Keep draft and close");
    await page.waitForURL(url => url.pathname === "/library" && url.searchParams.get("shell") === "cockpit" && url.searchParams.get("type") === "tool");
    const type = page.getByRole("combobox", { name: /^Type(?:\s|$)/u }); await type.waitFor();
    assert.equal(await type.inputValue(), "tool");
    await page.goBack(); await page.waitForURL(sourceUrl); await field.waitFor();
    assertNavigationDraftOwner({ before, after: await readGrants(), writes, origin,
      current: await page.evaluate(() => performance.timeOrigin), retained: await field.inputValue(), expected: value });
    // Explicitly discard this task-owned text-only draft; this never saves a grant.
    await reviewNavigationDraft(page, trigger, "Discard changes");
    await page.waitForURL(url => url.pathname === "/library");
    assert.deepEqual(writes, []);
    return { canceledBeforeNavigation: true, retainedAfterBack: true, grantWrites: 0 };
  } finally { page.off("request", record); }
}

/** Actual force-mounted Settings tabs keep text, while a different page requires leave consent. */
export async function proveRetainedSettingsTabDraft({ page, readGrants }) {
  const before = await readGrants(), writes = [];
  const record = request => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()) && new URL(request.url()).pathname.startsWith("/api/v1/tools/grants")) writes.push(request.method());
  };
  page.on("request", record);
  try {
    await page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "Safety", exact: true }).click();
    await page.getByRole("tab", { name: "Tools", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/settings/safety" && url.hash === "#approval-mode");
    const origin = await page.evaluate(() => performance.timeOrigin);
    const { field, value } = await fillNavigationGrantDraft(page);
    await page.getByRole("tab", { name: "Budgets", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/settings/safety" && url.hash === "#budget-mode");
    assert.equal(await page.getByRole("dialog", { name: "Unsaved changes", exact: true }).count(), 0);
    await page.getByRole("tab", { name: "Tools", exact: true }).click(); await field.waitFor();
    assert.equal(await field.inputValue(), value);
    const trigger = () => page.getByRole("navigation", { name: "Settings pages", exact: true }).getByRole("link", { name: "General", exact: true }).click();
    await reviewNavigationDraft(page, trigger, "Cancel");
    await reviewNavigationDraft(page, trigger, "Keep draft and close");
    await page.waitForURL(url => url.pathname === "/settings/general");
    await page.getByRole("tab", { name: "Appearance", exact: true }).waitFor();
    await page.goBack(); await page.waitForURL(url => url.pathname === "/settings/safety" && url.hash === "#approval-mode"); await field.waitFor();
    assertNavigationDraftOwner({ before, after: await readGrants(), writes, origin,
      current: await page.evaluate(() => performance.timeOrigin), retained: await field.inputValue(), expected: value });
    await reviewNavigationDraft(page, trigger, "Discard changes");
    await page.waitForURL(url => url.pathname === "/settings/general");
    return { sameMountedTabNoReview: true, crossPageReviewed: true, retainedAfterBack: true, grantWrites: 0 };
  } finally { page.off("request", record); }
}
