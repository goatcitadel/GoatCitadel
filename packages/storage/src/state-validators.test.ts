import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJsonObject, parseJsonArray, parseStringRecord } from "./state-validators.js";

describe("state-validators", () => {
  describe("parseJsonObject", () => {
    it("accepts plain objects", () => {
      const result = parseJsonObject({ a: 1, b: "x" });
      assert.equal(result.success, true);
      assert.deepEqual(result.data, { a: 1, b: "x" });
    });

    it("rejects arrays", () => {
      const result = parseJsonObject([1, 2]);
      assert.equal(result.success, false);
      assert.ok(result.error);
    });

    it("rejects null", () => {
      const result = parseJsonObject(null);
      assert.equal(result.success, false);
    });

    it("rejects primitives", () => {
      assert.equal(parseJsonObject(42).success, false);
      assert.equal(parseJsonObject("hi").success, false);
      assert.equal(parseJsonObject(true).success, false);
    });
  });

  describe("parseJsonArray", () => {
    it("accepts arrays", () => {
      const result = parseJsonArray([1, 2, 3]);
      assert.equal(result.success, true);
      assert.deepEqual(result.data, [1, 2, 3]);
    });

    it("rejects objects", () => {
      assert.equal(parseJsonArray({ a: 1 }).success, false);
    });

    it("rejects null", () => {
      assert.equal(parseJsonArray(null).success, false);
    });
  });

  describe("parseStringRecord", () => {
    it("accepts objects of string values", () => {
      const result = parseStringRecord({ a: "1", b: "2" });
      assert.equal(result.success, true);
      assert.deepEqual(result.data, { a: "1", b: "2" });
    });

    it("rejects when any value is non-string", () => {
      const result = parseStringRecord({ a: "1", b: 2 });
      assert.equal(result.success, false);
      assert.match(result.error?.message ?? "", /b/);
    });

    it("accepts empty object", () => {
      const result = parseStringRecord({});
      assert.equal(result.success, true);
      assert.deepEqual(result.data, {});
    });
  });
});
