import { describe, expect, it } from "vitest";
import { assertGitSourceHostIsPublic } from "./skill-import-service.js";

const resolvesTo =
  (...addresses: string[]) =>
  async () =>
    addresses.map((address) => ({ address }));

describe("assertGitSourceHostIsPublic (G2-10)", () => {
  it("accepts a public host resolving to public addresses", async () => {
    await expect(
      assertGitSourceHostIsPublic("https://github.com/o/r.git", resolvesTo("140.82.112.3")),
    ).resolves.toBeUndefined();
  });

  it.each([
    "https://127.0.0.1/r.git",
    "https://169.254.169.254/r.git",
    "https://10.0.0.5/r.git",
    "https://[::1]/r.git",
    "https://[::ffff:169.254.169.254]/r.git",
    "https://localhost/r.git",
  ])("blocks literal private target %s without resolving", async (ref) => {
    const lookup = async () => {
      throw new Error("lookup must not run");
    };
    await expect(assertGitSourceHostIsPublic(ref, lookup)).rejects.toThrow(/blocked|Private/i);
  });

  it("accepts a public IPv6 literal without resolving it", async () => {
    const lookup = async () => {
      throw new Error("lookup must not run");
    };
    await expect(assertGitSourceHostIsPublic("https://[2606:4700::1111]/r.git", lookup)).resolves.toBeUndefined();
  });

  it("blocks a public name that resolves to a private or metadata address", async () => {
    await expect(
      assertGitSourceHostIsPublic("https://evil.example/r.git", resolvesTo("93.184.216.34", "169.254.169.254")),
    ).rejects.toThrow(/Private/);
    await expect(assertGitSourceHostIsPublic("https://evil.example/r.git", resolvesTo("fd00::1"))).rejects.toThrow(
      /Private/,
    );
  });

  it("fails closed on resolution failure, empty results and non-https refs", async () => {
    await expect(
      assertGitSourceHostIsPublic("https://nx.example/r.git", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(/could not be resolved/);
    await expect(assertGitSourceHostIsPublic("https://nx.example/r.git", resolvesTo())).rejects.toThrow(/any address/);
    await expect(assertGitSourceHostIsPublic("git@github.com:o/r.git", resolvesTo("1.1.1.1"))).rejects.toThrow(/https/);
    await expect(assertGitSourceHostIsPublic("http://github.com/o/r.git", resolvesTo("1.1.1.1"))).rejects.toThrow(
      /https/,
    );
  });
});
