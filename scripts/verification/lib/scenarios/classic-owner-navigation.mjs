/** The shell marker is set before lazy classic chrome mounts. Await the chrome
 * before deciding whether an actual mobile drawer or collapsed rail needs opening. */
export async function clickClassicOwnerNavigation(page, target) {
  const topbar = page.locator(".mc-next-shell .mc-next-topbar");
  await topbar.waitFor({ state: "visible", timeout: 30_000 });
  if (!(await target.isVisible())) {
    await topbar.getByRole("button", { name: /^(Open navigation|Expand sidebar)$/u }).click();
  }
  await target.waitFor({ state: "visible", timeout: 30_000 });
  await target.click();
}
