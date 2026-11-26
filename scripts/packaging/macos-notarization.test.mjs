import assert from "node:assert/strict";
import test from "node:test";
import { notarizeMacDmg } from "./lib/macos-notarization.mjs";

const id = "c590c723-61d7-4baa-9a31-e1dcfc69df3b";
const credentials = { appleId: "test@example.invalid", teamId: "TESTTEAM", password: "notary-test-fixture" };

test("macOS notarization staples and validates only an accepted Apple submission", () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args.slice(0, 2)]);
    return { status: 0, stdout: JSON.stringify({ id, status: "Accepted" }) };
  };
  assert.equal(notarizeMacDmg("Mission Control.dmg", { ...credentials, spawn }), id);
  assert.deepEqual(calls, [
    ["xcrun", "notarytool", "submit"],
    ["xcrun", "stapler", "staple"],
    ["xcrun", "stapler", "validate"],
  ]);
});

test("macOS notarization refuses an unaccepted or malformed receipt before stapling", () => {
  for (const stdout of [JSON.stringify({ id, status: "Invalid" }), JSON.stringify({ status: "Accepted" }), "{"]) {
    const calls = [];
    const spawn = (_command, args) => {
      calls.push(args.slice(0, 2));
      return { status: 0, stdout };
    };
    assert.throws(() => notarizeMacDmg("Mission Control.dmg", { ...credentials, spawn }), /Apple notarization|Apple did not accept/);
    assert.deepEqual(calls, [["notarytool", "submit"]]);
  }
});

test("macOS notarization diagnostics omit credentials after exit and spawn failures", () => {
  const argvError = new Error(credentials.password);
  argvError.spawnargs = [credentials.appleId, credentials.password];
  for (const result of [
    { status: 1, stderr: credentials.password },
    { status: null, error: argvError },
  ]) {
    assert.throws(
      () => notarizeMacDmg("Mission Control.dmg", { ...credentials, spawn: () => result }),
      (error) => {
        assert.match(error.message, /xcrun notarytool submit failed/);
        for (const secret of Object.values(credentials)) assert.ok(!error.stack.includes(secret));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  }
});
