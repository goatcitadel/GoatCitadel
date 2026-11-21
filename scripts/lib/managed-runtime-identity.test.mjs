import assert from "node:assert/strict";
import test from "node:test";
import { queryWindowsProcessCreationIdentity } from "./managed-runtime-lifecycle.mjs";

function query(output, overrides = {}) {
  return queryWindowsProcessCreationIdentity(42, { exists: () => true, spawn: () => ({ status: 0, stdout: output, ...overrides }) });
}
test("direct Windows identity preserves legacy microsecond FILETIME without Number rounding", () => {
  for (const [native, canonical] of [["134364828009949541", "134364828009949540"], ["134364828009949549", "134364828009949540"], ["134364828009949540", "134364828009949540"], ["9223372036854775807", "9223372036854775800"]]) {
    assert.deepEqual(query("42|" + native + "\r\n"), { status: "running", identity: "windows:" + canonical });
  }
});
test("direct identity fails closed on wrong PID, malformed output, probe errors, or absent PowerShell", () => {
  for (const output of ["43|134364828009949541", "042|134364828009949541", "42|0", "42|invalid", "42|134364828009949541\n42|134364828009949541", "42|134364828009949541|extra", ""]) assert.deepEqual(query(output), { status: "unavailable" });
  assert.deepEqual(query("42|134364828009949541", { status: 1 }), { status: "unavailable" });
  assert.deepEqual(query("42|134364828009949541", { error: new Error("timeout") }), { status: "unavailable" });
  const spawn = () => { throw new Error("must not spawn"); };
  assert.deepEqual(queryWindowsProcessCreationIdentity(42, { exists: () => false, spawn }), { status: "unavailable" });
  for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) assert.deepEqual(queryWindowsProcessCreationIdentity(pid, { exists: () => true, spawn }), { status: "missing" });
  assert.deepEqual(query("missing\r\n"), { status: "missing" });
});
test("single-PID probe retains its bounded hidden-process invocation and uses kernel start time", () => {
  let calls = 0;
  const result = queryWindowsProcessCreationIdentity(42, { exists: () => true, spawn: (command, args, options) => {
    calls += 1;
    assert.match(command, /WindowsPowerShell/u);
    assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args[4], "base64").toString("utf16le");
    assert.match(script, /\[System\.Diagnostics\.Process\]::GetProcessById\(42\)/u);
    assert.match(script, /\.StartTime\.ToUniversalTime\(\)\.ToFileTimeUtc\(\)/u);
    assert.doesNotMatch(script, /Get-CimInstance|Get-WmiObject/u);
    assert.equal(options.timeout, 5000);
    assert.equal(options.windowsHide, true);
    assert.equal(options.maxBuffer, 64 * 1024);
    return { status: 0, stdout: "42|134364828009949541" };
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: "running", identity: "windows:134364828009949540" });
});

const nativeExecutable = "C:\\GoatCitadel\\app\\desktop\\GoatCitadel-Process-Identity.exe";

test("native Windows identity uses the same precise token and conclusive missing result", () => {
  for (const [stdout, expected] of [
    ["42|134364828009949549\r\n", { status: "running", identity: "windows:134364828009949540" }],
    ["missing\r\n", { status: "missing" }],
  ]) {
    const result = queryWindowsProcessCreationIdentity(42, {
      nativeExecutable,
      exists: (file) => file === nativeExecutable,
      spawn: (file, args, options) => {
        assert.equal(file, nativeExecutable);
        assert.deepEqual(args, ["42"]);
        assert.equal(options.windowsHide, true);
        assert.ok(options.timeout <= 1_000 && options.maxBuffer <= 256);
        return { status: 0, stdout };
      },
    });
    assert.deepEqual(result, expected);
  }
});

test("unavailable or malformed native identity falls back to the bounded legacy probe", () => {
  for (const nativeResult of [
    { status: 0, stdout: "43|134364828009949549" },
    { status: 0, stdout: "42|broken" },
    { status: 1, stdout: "missing" },
    { status: null, error: new Error("timeout") },
  ]) {
    const calls = [];
    const result = queryWindowsProcessCreationIdentity(42, {
      nativeExecutable,
      exists: () => true,
      spawn: (file) => {
        calls.push(file);
        return file === nativeExecutable ? nativeResult : { status: 0, stdout: "42|134364828009949540" };
      },
    });
    assert.deepEqual(result, { status: "running", identity: "windows:134364828009949540" });
    assert.equal(calls[0], nativeExecutable);
    assert.match(calls[1], /WindowsPowerShell/u);
    assert.equal(calls.length, 2);
  }
});
