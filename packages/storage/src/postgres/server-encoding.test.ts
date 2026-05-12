import assert from "node:assert/strict";
import test from "node:test";
import {
  escapeUnsupportedWindows1252Characters,
  normalizeServerEncoding,
  sanitizeParamsForServerEncoding,
} from "./server-encoding.js";

test("normalizes server encoding names and returns defensive param copies for non WIN1252 servers", () => {
  const params = [{ content: "plain 🧠" }];

  assert.equal(normalizeServerEncoding(" win1252 "), "WIN1252");
  assert.equal(normalizeServerEncoding(undefined), undefined);
  assert.deepEqual(sanitizeParamsForServerEncoding(params, undefined), params);
  assert.notEqual(sanitizeParamsForServerEncoding(params, "utf8"), params);
});

test("preserves windows-1252 punctuation while escaping unsupported characters", () => {
  const text = "Keep “quotes”, dashes -, Cyrillic Ж, and goats 🐐";
  assert.equal(
    escapeUnsupportedWindows1252Characters(text),
    "Keep “quotes”, dashes -, Cyrillic \\u0416, and goats \\uD83D\\uDC10",
  );
});

test("preserves plain text params while sanitizing structured WIN1252 payloads", () => {
  const nullPrototype = Object.create(null) as Record<string, unknown>;
  nullPrototype["emoji 🧪"] = "value 🧬";
  const params = ["plain 🧠", { nested: ["ok", "alert 🚨"] }, nullPrototype];

  assert.deepEqual(sanitizeParamsForServerEncoding(params, "WIN1252", "SELECT * FROM demo WHERE note = $1"), [
    "plain 🧠",
    { nested: ["ok", "alert \\uD83D\\uDEA8"] },
    { "emoji \\uD83E\\uDDEA": "value \\uD83E\\uDDEC" },
  ]);
  assert.deepEqual(sanitizeParamsForServerEncoding(params, "UTF8", "SELECT * FROM demo WHERE note = $1"), params);
});

test("sanitizes top-level write params for WIN1252 while preserving JSON string shape", () => {
  const params = ['{"content":"alert 🚨"}', '  ["alert 🚨"]', "plain 🧠"];

  assert.deepEqual(
    sanitizeParamsForServerEncoding(params, "win1252", "INSERT INTO demo(payload, note) VALUES ($1, $2)"),
    [String.raw`{"content":"alert \\uD83D\\uDEA8"}`, String.raw`  ["alert \\uD83D\\uDEA8"]`, "plain \\uD83E\\uDDE0"],
  );
  assert.deepEqual(sanitizeParamsForServerEncoding(["merge 🧪"], "WIN1252", "  MERGE INTO demo"), [
    "merge \\uD83E\\uDDEA",
  ]);
  assert.deepEqual(sanitizeParamsForServerEncoding(["update 🧪"], "WIN1252", "\nUPDATE demo SET note = $1"), [
    "update \\uD83E\\uDDEA",
  ]);
});
