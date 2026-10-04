// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { pass } from "../runner/assert";
import { INITIAL_RUN_STATE } from "../runner/state";
import { makeCheck } from "../test-support/scheduler-helpers";
import { buttonNamed, cleanup, click, pressKey, render, rowButtons, text } from "../test-support/ui-helpers";
import { CHECK_PAGE_SIZE, CheckList } from "./CheckList";

afterEach(cleanup);

function checksOf(count: number) {
  return Array.from({ length: count }, (_, index) =>
    makeCheck(`check-${String(index + 1).padStart(3, "0")}`, "read", async () => pass("ok")),
  );
}

async function renderList(count: number): Promise<void> {
  await render(
    <CheckList
      checks={checksOf(count)}
      state={INITIAL_RUN_STATE}
      selectedId={undefined}
      running={false}
      onSelect={vi.fn()}
      onRun={vi.fn()}
      permissionOf={() => ({ allowed: true })}
    />,
  );
}

function runButton(checkId: string): HTMLButtonElement {
  return buttonNamed(`Run ${checkId}`);
}

describe("CheckList arrow keys", () => {
  it("moves focus up and down between rows", async () => {
    await renderList(5);
    const rows = rowButtons();
    rows[2]?.focus();
    await pressKey(rows[2] as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(rows[1]);
    await pressKey(rows[1] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(rows[2]);
  });

  it("stays on the first row when ArrowUp is pressed there, and on the last row for ArrowDown", async () => {
    await renderList(5);
    const rows = rowButtons();
    rows[0]?.focus();
    await pressKey(rows[0] as HTMLElement, "ArrowUp");
    expect(document.activeElement).toBe(rows[0]);
    rows[4]?.focus();
    await pressKey(rows[4] as HTMLElement, "ArrowDown");
    expect(document.activeElement).toBe(rows[4]);
  });

  it("moves relative to the row whose Run button holds focus", async () => {
    await renderList(5);
    const rows = rowButtons();
    const thirdRun = runButton("check-003");
    thirdRun.focus();
    await pressKey(thirdRun, "ArrowDown");
    expect(document.activeElement).toBe(rows[3]);

    const fourthRun = runButton("check-004");
    fourthRun.focus();
    await pressKey(fourthRun, "ArrowUp");
    expect(document.activeElement).toBe(rows[2]);
  });

  it("ignores other keys", async () => {
    await renderList(5);
    const rows = rowButtons();
    rows[1]?.focus();
    await pressKey(rows[1] as HTMLElement, "Enter");
    expect(document.activeElement).toBe(rows[1]);
  });
});

describe("CheckList paging", () => {
  it("shows every row without a paging button up to the page size", async () => {
    await renderList(CHECK_PAGE_SIZE);
    expect(rowButtons()).toHaveLength(CHECK_PAGE_SIZE);
    expect(text()).not.toContain("hidden)");
  });

  it("offers to show more beyond the page size and reveals the rest page by page", async () => {
    await renderList(450);
    expect(rowButtons()).toHaveLength(200);
    await click(buttonNamed("Show 200 more (250 hidden)"));
    expect(rowButtons()).toHaveLength(400);
    await click(buttonNamed("Show 50 more (50 hidden)"));
    expect(rowButtons()).toHaveLength(450);
    expect(text()).not.toContain("hidden)");
  });
});
