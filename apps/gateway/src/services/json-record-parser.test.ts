import { describe, expect, it } from "vitest";
import { parseLooseJsonRecord } from "./json-record-parser.js";

describe("parseLooseJsonRecord", () => {
  it("parses direct JSON objects", () => {
    expect(parseLooseJsonRecord("{\"status\":\"ok\",\"score\":1}")).toEqual({
      status: "ok",
      score: 1,
    });
  });

  it("prefers fenced JSON objects", () => {
    expect(parseLooseJsonRecord("```json\n{\"status\":\"fenced\"}\n```")).toEqual({
      status: "fenced",
    });
  });

  it("extracts fenced JSON surrounded by prose", () => {
    expect(parseLooseJsonRecord("Here is the payload:\n```json\n{\"status\":\"wrapped\"}\n```\nUse it.")).toEqual({
      status: "wrapped",
    });
  });

  it("repairs loose JSON with smart quotes and trailing commas", () => {
    expect(parseLooseJsonRecord("“status”: “ok”, \"items\": [1,2,],")).toBeUndefined();
    expect(parseLooseJsonRecord("{“status”: “ok”, 'reason': 'done',}")).toEqual({
      status: "ok",
      reason: "done",
    });
  });

  it("rejects non-object payloads", () => {
    expect(parseLooseJsonRecord("[1,2,3]")).toBeUndefined();
    expect(parseLooseJsonRecord("```json\n[1,2,3]\n```")).toBeUndefined();
  });
});
