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
    "Keep “quotes”, dashes -, and goats \\uD83D\\uDC10",
  );
});

test("preserves plain text params while sanitizing structured WIN1252 payloads", () => {
  const params = [
    "plain 🧠",
    { nested: ["ok", "alert 🚨"] },
  ];

  assert.deepEqual(sanitizeParamsForServerEncoding(params, "WIN1252", "SELECT * FROM demo WHERE note = $1"), [
    "plain 🧠",
    { nested: ["ok", "alert \\uD83D\\uDEA8"] },
  ]);
  assert.deepEqual(sanitizeParamsForServerEncoding(params, "UTF8", "SELECT * FROM demo WHERE note = $1"), params);
});

test("sanitizes top-level JSON string params for WIN1252 while leaving plain text alone", () => {
  const params = [
    '{"content":"alert 🚨"}',
    "plain 🧠",
  ];

  assert.deepEqual(sanitizeParamsForServerEncoding(params, "WIN1252", "INSERT INTO demo(payload, note) VALUES ($1, $2)"), [
    String.raw`{"content":"alert \\uD83D\\uDEA8"}`,
    "plain \\uD83E\\uDDE0",
  ]);
});
