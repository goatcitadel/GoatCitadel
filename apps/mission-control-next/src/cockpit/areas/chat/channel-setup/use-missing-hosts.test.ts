import { describe, expect, it } from "vitest";
import { missingHosts } from "./use-missing-hosts";

describe("missingHosts", () => {
  it("names a host the allowlist does not have", () => {
    expect(missingHosts(["api.telegram.org"], [])).toEqual(["api.telegram.org"]);
    expect(missingHosts(["api.telegram.org"], ["example.com"])).toEqual(["api.telegram.org"]);
  });

  it("leaves out a host that is allowed, exactly or by a wildcard, in any case", () => {
    expect(missingHosts(["api.telegram.org"], ["api.telegram.org"])).toEqual([]);
    expect(missingHosts(["api.telegram.org"], ["API.Telegram.org"])).toEqual([]);
    expect(missingHosts(["api.telegram.org"], ["*.telegram.org"])).toEqual([]);
    expect(missingHosts(["api.telegram.org"], ["*"])).toEqual([]);
  });

  it("names each missing host once", () => {
    expect(missingHosts(["a.example", "b.example", "a.example"], ["b.example"])).toEqual(["a.example"]);
  });

  it("names none when the channel needs none", () => {
    expect(missingHosts([], [])).toEqual([]);
  });
});
