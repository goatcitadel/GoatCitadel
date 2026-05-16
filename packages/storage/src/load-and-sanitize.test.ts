import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadAndSanitize, type QuarantineEntry, type SafeParse } from "./load-and-sanitize.js";

const okParse: SafeParse<Record<string, unknown>> = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? { success: true, data: value as Record<string, unknown> }
    : { success: false, error: { message: "expected object" } };

describe("loadAndSanitize", () => {
  it("returns fallback for null without quarantine", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize(
      null,
      {
        store: "test",
        rowId: "row-1",
        parse: okParse,
        onQuarantine: (e) => entries.push(e),
      },
      undefined,
    );
    assert.equal(out, undefined);
    assert.equal(entries.length, 0);
  });

  it("returns fallback for empty string without quarantine", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize(
      "",
      {
        store: "test",
        rowId: "row-1",
        parse: okParse,
        onQuarantine: (e) => entries.push(e),
      },
      { fallback: true },
    );
    assert.deepEqual(out, { fallback: true });
    assert.equal(entries.length, 0);
  });

  it("quarantines malformed JSON and returns fallback", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize(
      "{not json",
      {
        store: "test",
        rowId: "row-2",
        parse: okParse,
        onQuarantine: (e) => entries.push(e),
      },
      undefined,
    );
    assert.equal(out, undefined);
    assert.equal(entries.length, 1);
    const entry0 = entries[0];
    assert.ok(entry0, "expected quarantine entry");
    assert.equal(entry0.store, "test");
    assert.equal(entry0.rowId, "row-2");
    assert.equal(entry0.rawValue, "{not json");
    assert.match(entry0.schemaError, /^json_parse:/);
  });

  it("quarantines parses-but-fails-schema rows", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize(
      "[1,2,3]",
      {
        store: "test",
        rowId: "row-3",
        parse: okParse,
        onQuarantine: (e) => entries.push(e),
      },
      undefined,
    );
    assert.equal(out, undefined);
    assert.equal(entries.length, 1);
    const entry0 = entries[0];
    assert.ok(entry0, "expected quarantine entry");
    assert.equal(entry0.rawValue, "[1,2,3]");
    assert.match(entry0.schemaError, /^schema:/);
  });

  it("returns parsed value when schema accepts", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize(
      '{"a":1}',
      {
        store: "test",
        rowId: "row-4",
        parse: okParse,
        onQuarantine: (e) => entries.push(e),
      },
      undefined,
    );
    assert.deepEqual(out, { a: 1 });
    assert.equal(entries.length, 0);
  });

  it("does not throw when onQuarantine throws", () => {
    const out = loadAndSanitize(
      "{not json",
      {
        store: "test",
        rowId: "row-5",
        parse: okParse,
        onQuarantine: () => {
          throw new Error("sink failed");
        },
      },
      undefined,
    );
    assert.equal(out, undefined);
  });

  it("accepts non-string raw and runs the parser directly", () => {
    const entries: QuarantineEntry[] = [];
    const out = loadAndSanitize(
      { already: "parsed" },
      {
        store: "test",
        rowId: "row-6",
        parse: okParse,
        onQuarantine: (e) => entries.push(e),
      },
      undefined,
    );
    assert.deepEqual(out, { already: "parsed" });
    assert.equal(entries.length, 0);
  });

  it("quarantines parser-contract violation when success is true but data is undefined", () => {
    const entries: QuarantineEntry[] = [];
    const brokenParse: SafeParse<Record<string, unknown>> = () => ({ success: true });
    const out = loadAndSanitize(
      '{"x":1}',
      {
        store: "test",
        rowId: "row-7",
        parse: brokenParse,
        onQuarantine: (e) => entries.push(e),
      },
      undefined,
    );
    assert.equal(out, undefined);
    assert.equal(entries.length, 1);
    const entry0 = entries[0];
    assert.ok(entry0, "expected quarantine entry");
    assert.match(entry0.schemaError, /contract violation/);
  });
});
