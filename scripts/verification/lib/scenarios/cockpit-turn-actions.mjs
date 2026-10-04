// Phones keep Retry and Copy inline and move the other turn actions into one
// "More turn actions" menu. These helpers drive either layout by accessible name.
export const MORE_TURN_ACTIONS = "More turn actions";

function controls(scope, name) {
  return {
    inline: scope.getByRole("button", { name, exact: true }).last(),
    more: scope.getByRole("button", { name: MORE_TURN_ACTIONS, exact: true }).last(),
  };
}

async function openOverflow(scope, more) {
  await more.click();
  const menu = scope.page().getByRole("menu");
  await menu.waitFor();
  return menu;
}

async function closeOverflow(scope, menu) {
  await scope.page().keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
}

/** Click a turn action whether it is inline (wider screens) or in the phone overflow menu. */
export async function clickTurnAction(scope, name, { timeout } = {}) {
  const { inline, more } = controls(scope, name);
  await inline.or(more).first().waitFor({ timeout });
  if (await inline.isVisible()) return await inline.click({ timeout });
  const menu = await openOverflow(scope, more);
  await menu.getByRole("menuitem", { name, exact: true }).click({ timeout });
}

/** Wait until a turn action is offered, then leave the layout as it was. */
export async function waitForTurnAction(scope, name, { timeout } = {}) {
  const { inline, more } = controls(scope, name);
  await inline.or(more).first().waitFor({ timeout });
  if (await inline.isVisible()) return;
  const menu = await openOverflow(scope, more);
  await menu.getByRole("menuitem", { name, exact: true }).waitFor({ timeout });
  await closeOverflow(scope, menu);
}

/** Count offers of one action across the inline row and the phone overflow menu. */
export async function countTurnAction(scope, name) {
  const { more } = controls(scope, name);
  const inlineCount = await scope.getByRole("button", { name, exact: true }).count();
  if (inlineCount || !(await more.isVisible())) return inlineCount;
  const menu = await openOverflow(scope, more);
  const overflowCount = await menu.getByRole("menuitem", { name, exact: true }).count();
  await closeOverflow(scope, menu);
  return overflowCount;
}
