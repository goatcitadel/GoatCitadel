import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./change-plans.css", import.meta.url)), "utf8");

it("styles the change-plan confirm as accent and a danger confirm as red in the Cockpit (U-ST-005)", () => {
  expect(css).toMatch(
    /\.chat-change-plan-modal\s+\.gc-modal-actions\s+button:last-child:not\(\[data-variant="destructive"\]\) \{\s*border-color: var\(--cockpit-accent\);/,
  );
  expect(css).toMatch(
    /\.chat-change-plan-modal\s+\.gc-modal-actions\s+button\[data-variant="destructive"\] \{\s*border-color: var\(--cockpit-failed\);\s*background: var\(--cockpit-failed\);/,
  );
});
