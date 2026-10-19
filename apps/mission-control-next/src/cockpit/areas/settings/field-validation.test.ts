import { describe, expect, it } from "vitest";
import { jsonObjectFieldError, urlFieldError } from "./field-validation";

describe("settings field validation", () => {
  it("accepts full http and https URLs and explains anything else", () => {
    expect(urlFieldError("https://api.example.test/v1")).toBeUndefined();
    expect(urlFieldError("http://127.0.0.1:9999/v1")).toBeUndefined();
    expect(urlFieldError("")).toBeUndefined();
    expect(urlFieldError("  ", { required: true })).toBe("Enter a URL.");
    expect(urlFieldError("api.example.test")).toBe("Enter a full URL, starting with https:// or http://.");
    expect(urlFieldError("ftp://example.test")).toBe("Use a URL that starts with http:// or https://.");
    expect(urlFieldError("http://example.test", { protocols: ["https:"] })).toBe(
      "Use a URL that starts with https://.",
    );
  });

  it("accepts an empty field or a JSON object of text values", () => {
    expect(jsonObjectFieldError("")).toBeUndefined();
    expect(jsonObjectFieldError('{"X-Client": "GoatCitadel"}')).toBeUndefined();
    expect(jsonObjectFieldError("{X-Client: 1")).toContain("Enter valid JSON");
    expect(jsonObjectFieldError('["a"]')).toBe("Enter a JSON object in curly braces.");
    expect(jsonObjectFieldError('{"X-Retries": 3}')).toBe("Each header value must be text in quotes.");
  });
});
