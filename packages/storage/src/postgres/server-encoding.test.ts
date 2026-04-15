import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeUnsupportedWindows1252Characters,
  sanitizeParamsForServerEncoding,
} from "./server-encoding.js";

test("preserves windows-1252 punctuation while escaping unsupported characters", () => {
  const text = "Keep “quotes”, dashes -, and goats 🐐";
  assert.equal(
    escapeUnsupportedWindows1252Characters(text),
    "Keep “quotes”, dashes -, and goats \\u{1F410}",
  );
});

test("sanitizes nested params only when server encoding is WIN1252", () => {
  const params = [
    "plain 🧠",
    { nested: ["ok", "alert 🚨"] },
  ];

  assert.deepEqual(sanitizeParamsForServerEncoding(params, "WIN1252"), [
    "plain \\u{1F9E0}",
    { nested: ["ok", "alert \\u{1F6A8}"] },
  ]);
  assert.deepEqual(sanitizeParamsForServerEncoding(params, "UTF8"), params);
});
