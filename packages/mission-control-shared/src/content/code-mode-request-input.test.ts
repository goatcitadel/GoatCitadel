import { describe, expect, it } from "vitest";
import { codeModeRequestInput } from "./code-mode-request-input";

describe("codeModeRequestInput", () => {
  it("shows the input as compact JSON", () => {
    expect(codeModeRequestInput({ path: "a.pdf", page: 2 })).toBe('{"path":"a.pdf","page":2}');
    expect(codeModeRequestInput(["a", 1])).toBe('["a",1]');
    expect(codeModeRequestInput("text")).toBe('"text"');
  });

  it("shows nothing for a request that hands its code no input", () => {
    expect(codeModeRequestInput(undefined)).toBeUndefined();
    expect(codeModeRequestInput(null)).toBeUndefined();
    expect(codeModeRequestInput({})).toBeUndefined();
  });
});
