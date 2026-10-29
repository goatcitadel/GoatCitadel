import { describe, expect, it } from "vitest";
import {
  PUBLIC_WEB_ADDRESS_HAS_EXTRA,
  PUBLIC_WEB_ADDRESS_HAS_LOGIN,
  PUBLIC_WEB_ADDRESS_MAX_LENGTH,
  PUBLIC_WEB_ADDRESS_NOT_HTTPS,
  PUBLIC_WEB_ADDRESS_NOT_PUBLIC,
  PUBLIC_WEB_ADDRESS_NOT_URL,
  PUBLIC_WEB_ADDRESS_TOO_LONG,
  checkPublicWebAddress,
  publicWebAddressFor,
} from "./public-web-address.js";

describe("checkPublicWebAddress", () => {
  it("keeps an https address and drops the trailing slash", () => {
    expect(checkPublicWebAddress("  https://Example.com/goat/ ")).toEqual({
      ok: true,
      address: "https://example.com/goat",
    });
    expect(checkPublicWebAddress("https://goat.example.com")).toEqual({
      ok: true,
      address: "https://goat.example.com",
    });
    expect(checkPublicWebAddress("https://goat.example.com:8443/")).toEqual({
      ok: true,
      address: "https://goat.example.com:8443",
    });
  });

  it("drops the port https assumes anyway", () => {
    expect(checkPublicWebAddress("https://goat.example.com:443/goat")).toEqual({
      ok: true,
      address: "https://goat.example.com/goat",
    });
  });

  it("gives the same address back when it is checked again", () => {
    const first = checkPublicWebAddress("HTTPS://Goat.Example.com:8443/a/b///");
    expect(first).toEqual({ ok: true, address: "https://goat.example.com:8443/a/b" });
    if (first.ok) expect(checkPublicWebAddress(first.address)).toEqual(first);
  });

  it("refuses what Meta can't send to", () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ["example.com", PUBLIC_WEB_ADDRESS_NOT_URL],
      ["http://example.com", PUBLIC_WEB_ADDRESS_NOT_HTTPS],
      ["https://user:pw@example.com", PUBLIC_WEB_ADDRESS_HAS_LOGIN],
      ["https://example.com/?a=1", PUBLIC_WEB_ADDRESS_HAS_EXTRA],
      ["https://example.com/#x", PUBLIC_WEB_ADDRESS_HAS_EXTRA],
      ["https://" + "a".repeat(200) + ".com", PUBLIC_WEB_ADDRESS_TOO_LONG],
    ];
    for (const [input, problem] of refused) {
      expect(checkPublicWebAddress(input), input).toEqual({ ok: false, problem });
    }
  });

  it("reads an address with no scheme, or one that is not a web address, as not an address", () => {
    for (const input of [
      "",
      "   ",
      "localhost:8080",
      "example.com:8443/goat",
      "mailto:someone@example.com",
      "https://",
    ]) {
      expect(checkPublicWebAddress(input), input).toEqual({ ok: false, problem: PUBLIC_WEB_ADDRESS_NOT_URL });
    }
    expect(checkPublicWebAddress("ftp://example.com")).toEqual({ ok: false, problem: PUBLIC_WEB_ADDRESS_NOT_HTTPS });
  });

  it("refuses a bare ? or # as extra, and the login before the extra", () => {
    expect(checkPublicWebAddress("https://example.com/?")).toEqual({
      ok: false,
      problem: PUBLIC_WEB_ADDRESS_HAS_EXTRA,
    });
    expect(checkPublicWebAddress("https://example.com/#")).toEqual({
      ok: false,
      problem: PUBLIC_WEB_ADDRESS_HAS_EXTRA,
    });
    expect(checkPublicWebAddress("https://user@example.com/?a=1")).toEqual({
      ok: false,
      problem: PUBLIC_WEB_ADDRESS_HAS_LOGIN,
    });
  });

  it("checks the length before it parses anything", () => {
    const tooLong = "x".repeat(PUBLIC_WEB_ADDRESS_MAX_LENGTH + 1);
    expect(checkPublicWebAddress(tooLong)).toEqual({ ok: false, problem: PUBLIC_WEB_ADDRESS_TOO_LONG });
    expect(checkPublicWebAddress(`http://${"a".repeat(PUBLIC_WEB_ADDRESS_MAX_LENGTH)}`)).toEqual({
      ok: false,
      problem: PUBLIC_WEB_ADDRESS_TOO_LONG,
    });
  });

  it("refuses an address that is longer once the URL parser has written it out", () => {
    // Each "ü" in the path is six characters (%C3%BC) in the address the parser gives back.
    const address = `https://example.com/${"ü".repeat(40)}`;
    expect(address.length).toBeLessThanOrEqual(PUBLIC_WEB_ADDRESS_MAX_LENGTH);
    expect(checkPublicWebAddress(address)).toEqual({ ok: false, problem: PUBLIC_WEB_ADDRESS_TOO_LONG });
  });

  it("refuses addresses on this computer or a home network", () => {
    const privateAddresses = [
      "https://localhost",
      "https://goat.localhost",
      "https://127.0.0.1",
      "https://10.1.2.3",
      "https://172.16.0.1",
      "https://192.168.1.5",
      "https://169.254.1.1",
      "https://100.64.0.1",
      "https://0.0.0.0",
      "https://[::1]",
      "https://[fe80::1]",
      "https://[fd00::1]",
      "https://[::ffff:192.168.1.5]",
    ];
    for (const input of privateAddresses) {
      expect(checkPublicWebAddress(input), input).toEqual({ ok: false, problem: PUBLIC_WEB_ADDRESS_NOT_PUBLIC });
    }
  });

  it("refuses the other spellings the URL parser folds into those addresses", () => {
    const spellings = [
      "https://LOCALHOST",
      "https://localhost.",
      "https://goat.localhost.",
      "https://127.1",
      "https://0x7f.0.0.1",
      "https://2130706433",
      "https://[::]",
      "https://[0:0:0:0:0:0:0:1]",
      "https://[fc00::1]",
      "https://[FE80::1]",
      "https://[febf::1]",
      // The parser writes an IPv4-mapped host in hex, so both spellings of the same address arrive that way.
      "https://[::ffff:c0a8:105]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:a00:1]",
      "https://[::ffff:0:1]",
    ];
    for (const input of spellings) {
      expect(checkPublicWebAddress(input), input).toEqual({ ok: false, problem: PUBLIC_WEB_ADDRESS_NOT_PUBLIC });
    }
  });

  it("refuses the edges of each private range and nothing past them", () => {
    const refused = [
      "https://0.255.255.255",
      "https://10.255.255.255",
      "https://100.127.255.255",
      "https://127.255.255.255",
      "https://169.254.255.255",
      "https://172.31.255.255",
      "https://192.168.255.255",
    ];
    for (const input of refused) {
      expect(checkPublicWebAddress(input), input).toEqual({ ok: false, problem: PUBLIC_WEB_ADDRESS_NOT_PUBLIC });
    }
    const allowed: ReadonlyArray<readonly [string, string]> = [
      ["https://1.0.0.1", "https://1.0.0.1"],
      ["https://11.0.0.1", "https://11.0.0.1"],
      ["https://100.63.255.255", "https://100.63.255.255"],
      ["https://100.128.0.1", "https://100.128.0.1"],
      ["https://169.253.1.1", "https://169.253.1.1"],
      ["https://172.15.0.1", "https://172.15.0.1"],
      ["https://172.32.0.1", "https://172.32.0.1"],
      ["https://192.167.1.1", "https://192.167.1.1"],
      ["https://8.8.8.8", "https://8.8.8.8"],
      ["https://[2001:4860:4860::8888]", "https://[2001:4860:4860::8888]"],
      ["https://[::ffff:8.8.8.8]", "https://[::ffff:808:808]"],
      ["https://[fec0::1]", "https://[fec0::1]"],
      ["https://[fbff::1]", "https://[fbff::1]"],
      ["https://[fe00::1]", "https://[fe00::1]"],
    ];
    for (const [input, address] of allowed) {
      expect(checkPublicWebAddress(input), input).toEqual({ ok: true, address });
    }
  });

  it("does not take a name that only contains a private word for a private host", () => {
    for (const input of [
      "https://localhost.example.com",
      "https://notlocalhost.com",
      "https://localhostx.localhost.net",
    ]) {
      expect(checkPublicWebAddress(input), input).toMatchObject({ ok: true });
    }
  });

  it("uses the agreed sentences", () => {
    expect(PUBLIC_WEB_ADDRESS_NOT_URL).toBe("Enter a full address that starts with https://.");
    expect(PUBLIC_WEB_ADDRESS_NOT_HTTPS).toBe(
      "Use an https:// address. Meta and the other services send only to secure addresses.",
    );
    expect(PUBLIC_WEB_ADDRESS_HAS_LOGIN).toBe("Leave the user name and password out of the address.");
    expect(PUBLIC_WEB_ADDRESS_HAS_EXTRA).toBe("Leave out anything after ? or #.");
    expect(PUBLIC_WEB_ADDRESS_NOT_PUBLIC).toBe(
      "Use an address the internet can reach, not one on this computer or your home network.",
    );
    expect(PUBLIC_WEB_ADDRESS_TOO_LONG).toBe("Use an address under 200 characters.");
    expect(PUBLIC_WEB_ADDRESS_MAX_LENGTH).toBe(200);
  });

  it("never repeats what was typed in a problem", () => {
    const typed = [
      "https://user:hunter2@example.com",
      "https://example.com/?token=hunter2",
      "http://hunter2.example.com",
      "https://192.168.1.77",
    ];
    for (const input of typed) {
      const result = checkPublicWebAddress(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) {
        expect(result.problem).not.toContain("hunter2");
        expect(result.problem).not.toContain("192.168");
      }
    }
  });
});

describe("publicWebAddressFor", () => {
  it("joins the address and a route path", () => {
    expect(publicWebAddressFor("https://example.com/goat", "/api/v1/x")).toBe("https://example.com/goat/api/v1/x");
    expect(publicWebAddressFor("https://example.com", "/api/v1/x")).toBe("https://example.com/api/v1/x");
    expect(publicWebAddressFor(undefined, "/api/v1/x")).toBeUndefined();
  });

  it("joins one slash whether or not either side has it", () => {
    expect(publicWebAddressFor("https://example.com/goat/", "api/v1/x")).toBe("https://example.com/goat/api/v1/x");
    expect(publicWebAddressFor("https://example.com/goat", "api/v1/x")).toBe("https://example.com/goat/api/v1/x");
    expect(publicWebAddressFor("https://example.com/goat/", "/api/v1/x")).toBe("https://example.com/goat/api/v1/x");
  });

  it("gives nothing for an address that is not set", () => {
    expect(publicWebAddressFor("", "/api/v1/x")).toBeUndefined();
  });
});
