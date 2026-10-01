import assert from "node:assert/strict";
import { it } from "node:test";
import { assertShellGeometry } from "./cockpit-shell-controls-proof.mjs";

it("requires the actual desktop split, tablet overlay and 56px rail", () => {
  const desktop = { variant: "desktop", viewportWidth: 1440, railWidth: 56, inspectorWidth: 384, mainBefore: 1384, mainDuring: 1000, overflow: 0 };
  assert.doesNotThrow(() => assertShellGeometry(desktop));
  assert.doesNotThrow(() => assertShellGeometry({ ...desktop, variant: "tablet", viewportWidth: 800, mainBefore: 744, mainDuring: 744 }));
  assert.throws(() => assertShellGeometry({ ...desktop, railWidth: 248 }));
  assert.throws(() => assertShellGeometry({ ...desktop, inspectorWidth: 481 }));
  assert.throws(() => assertShellGeometry({ ...desktop, inspectorWidth: 359 }));
  assert.throws(() => assertShellGeometry({ ...desktop, variant: "tablet" }));
  assert.throws(() => assertShellGeometry({ ...desktop, mainDuring: desktop.mainBefore }));
  assert.throws(() => assertShellGeometry({ ...desktop, overflow: 2 }));
});
it("requires a phone sheet within the viewport with no visible desktop rail", () => {
  const phone = { variant: "mobile", viewportWidth: 390, railWidth: 0, inspectorWidth: 360, mainBefore: 390, mainDuring: 390, overflow: 0 };
  assert.doesNotThrow(() => assertShellGeometry(phone));
  assert.throws(() => assertShellGeometry({ ...phone, railWidth: 56 }));
  assert.throws(() => assertShellGeometry({ ...phone, inspectorWidth: 391 }));
});
