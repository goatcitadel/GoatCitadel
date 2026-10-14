import { assertNativeShellPresence } from "./cockpit-native-presence-proof.mjs";
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

it("binds native presence to its canonical acknowledgement, independent client and workspace lease", () => {
  const leaseId = "123e4567-e89b-42d3-a456-426614174000";
  const body = {workspaceId:"a",clientId:"client",leaseId,focused:true,visible:true,ttlMs:90000};
  const receipt = {...body,updatedAt:"2026-10-14T00:00:00.000Z",expiresAt:"2026-10-14T00:01:30.000Z"}; delete receipt.ttlMs;
  const entry = {method:"PUT",pathname:"/api/v1/notifications/presence",body,receipt,status:200};
  const expected = {clientId:"client",sessionsByWorkspace:{a:"session-a",b:undefined}};
  const leases = new Map();
  assert.doesNotThrow(()=>assertNativeShellPresence(entry,expected,leases));
  assert.doesNotThrow(()=>assertNativeShellPresence({...entry,body:{...body,sessionId:"session-a"},receipt:{...receipt,sessionId:"session-a"}},expected,leases));
  for(const change of [{receipt:{...receipt,leaseId:""}},{receipt:{...receipt,leaseId:"123e4567-e89b-42d3-a456-426614174001"}},{body:{...body,workspaceId:"foreign"}},{body:{...body,clientId:"foreign"}},{body:{...body,sessionId:"foreign"},receipt:{...receipt,sessionId:"foreign"}},{receipt:{...receipt,expiresAt:"2026-10-14T00:02:30.000Z"}}]) assert.throws(()=>assertNativeShellPresence({...entry,...change},expected,new Map()));
  assert.throws(()=>assertNativeShellPresence({...entry,body:{...body,workspaceId:"b"},receipt:{...receipt,workspaceId:"b"}},expected,leases));
});
it("keeps tablet overlay geometry bounded without claiming a docked resize handle", () => {
  const tablet = {variant:"tablet",viewportWidth:800,railWidth:56,inspectorWidth:768,mainBefore:744,mainDuring:744,overflow:0};
  assert.doesNotThrow(()=>assertShellGeometry(tablet));
  for(const change of [{inspectorWidth:801},{inspectorWidth:0},{mainDuring:500},{railWidth:248},{overflow:2}]) assert.throws(()=>assertShellGeometry({...tablet,...change}));
});
