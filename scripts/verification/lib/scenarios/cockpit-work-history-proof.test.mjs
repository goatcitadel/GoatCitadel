import assert from "node:assert/strict";
import test from "node:test";
import { assertHistoryWindow } from "./cockpit-work-history-proof.mjs";

test("history windows retain owner positions, totals, native scope and bounded rows", () => {
  const expected = Array.from({ length: 5 }, (_, index) => `/work/runs/run-${index}?shell=cockpit`);
  const rows = [2, 3].map(position => ({ position, total: 5, href: expected[position - 1] }));
  assert.doesNotThrow(() => assertHistoryWindow(rows, expected));
  for (const invalid of [[], [...rows, rows[0]], [...rows].reverse(),
    rows.map(row => ({ ...row, total: 6 })),
    rows.map(row => ({ ...row, href: row.href.replace("run-", "foreign-") })),
    rows.map(row => ({ ...row, href: row.href.replace("?shell=cockpit", "") })),
    expected.map((href, index) => ({ position: index + 1, total: 5, href })),
    [{ ...rows[0], position: 0 }], [{ ...rows[0], position: 1.5 }],
    [rows[0], { position: 4, total: 5, href: expected[3] }]]) {
    assert.throws(() => assertHistoryWindow(invalid, expected));
  }
});
