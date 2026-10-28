import { describe, expect, it } from "vitest";
import { channelAddressHost, isChannelAddressHost } from "./channel-address-host.js";

describe("channelAddressHost", () => {
  it.each([
    ["https://hooks.slack.com/services/T000/B000/XXXX", "hooks.slack.com"],
    ["https://Example.COM/path", "example.com"],
    ["https://ntfy.example.com:8443/topic", "ntfy.example.com:8443"],
    ["https://example.com:443/", "example.com"],
    ["http://example.com:80/", "example.com"],
    ["https://example.com:80/", "example.com:80"],
    ["http://192.168.0.10:8080/", "192.168.0.10:8080"],
    ["https://[::1]:8443/", "[::1]:8443"],
    ["https://bücher.example/", "xn--bcher-kva.example"],
  ])("reads the host of %s as %s", (address, host) => {
    expect(channelAddressHost(address)).toBe(host);
  });

  it("accepts underscores in host labels, as Docker and LAN names use them", () => {
    expect(channelAddressHost("http://signal_cli:8080/v1/send")).toBe("signal_cli:8080");
    expect(channelAddressHost("https://_matrix.example.org/")).toBe("_matrix.example.org");
  });

  it("gives back the host alone, never the credentials, path, query or fragment", () => {
    const host = channelAddressHost("https://user:pa55@hooks.slack.com:443/services/T0/B0/s3cret?token=t0k#frag");
    expect(host).toBe("hooks.slack.com");
    for (const part of ["user", "pa55", "services", "s3cret", "token", "t0k", "frag"]) expect(host).not.toContain(part);
  });

  it.each([
    ["a wildcard", "https://*.example.com/x"],
    ["a bare wildcard", "https://*/"],
    ["a percent-encoded wildcard", "https://%2A.example.com/"],
    ["another scheme", "ftp://files.example.com/"],
    ["a websocket address", "wss://example.com/socket"],
    ["an address with no scheme", "hooks.slack.com/services/T0"],
    ["an empty label", "https://example..com/"],
    // The Gateway's network guard matches `example.com.` and `example.com` as different hosts, so allowing the bare
    // name would not let the dotted address through. The address names no host the page can truthfully offer.
    ["a trailing dot", "https://example.com./"],
    ["the redaction marker", "[REDACTED]"],
    ["an empty string", ""],
    ["a non-string", 42],
  ])("names no host for %s", (_case, value) => {
    expect(channelAddressHost(value)).toBeUndefined();
  });
});

describe("isChannelAddressHost", () => {
  it.each(["hooks.slack.com", "ntfy.example.com:8443", "signal_cli:8080", "192.168.0.10", "[::1]:8443", "localhost"])(
    "accepts %s",
    (host) => {
      expect(isChannelAddressHost(host)).toBe(true);
    },
  );

  it.each([
    "*",
    "*.example.com",
    "example.com.",
    "Example.com",
    "example.com/path",
    "user@example.com",
    "https://example.com",
    "example.com:",
    "example.com:port",
    "[REDACTED]",
    "",
    " example.com",
    undefined,
    7,
  ])("rejects %s", (value) => {
    expect(isChannelAddressHost(value)).toBe(false);
  });
});
