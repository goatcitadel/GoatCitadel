import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "@goatcitadel/contracts";
import { fetchAllowlistedOnce } from "@goatcitadel/policy-engine";
import {
  computeLocalPluginManifestIntegrity,
  parseNpmPackageSpec,
  parseSriIntegrity,
  verifyIntegrationPluginPackage,
} from "./integration-plugin-package-integrity.js";

const TARBALL = Buffer.from("fixture-tarball");
const sri = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const sri256 = (text: string) => `sha256-${createHash("sha256").update(text).digest("base64")}`;
const REGISTRY = "registry.npmjs.org";
const NOW = new Date("2026-10-18T00:00:00.000Z");

let roots: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(await realpath(os.tmpdir()), "gc-plugin-integrity-"));
  roots.push(dir);
  return dir;
}
beforeEach(() => {
  roots = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

function fakeFetch(options: {
  integrity?: string;
  tarballUrl?: string;
  tarball?: Buffer;
}): typeof fetchAllowlistedOnce & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (url.startsWith("https://registry.npmjs.org/") && !url.endsWith(".tgz")) {
      return new Response(
        JSON.stringify({
          dist: {
            tarball: options.tarballUrl ?? "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz",
            integrity: options.integrity ?? sri(TARBALL),
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(new Uint8Array(options.tarball ?? TARBALL), { status: 200 });
  }) as unknown as typeof fetchAllowlistedOnce & { calls: string[] };
  fn.calls = calls;
  return fn;
}

async function npmInput(extra: Partial<Parameters<typeof verifyIntegrationPluginPackage>[0]> = {}) {
  const store = path.join(await tmp(), "integration-plugins");
  return {
    pluginId: "demo-plugin",
    source: "npm:pkg@1.0.0",
    sourceType: "npm" as const,
    networkAllowlist: [REGISTRY],
    pluginStoreRoot: store,
    now: () => NOW,
    ...extra,
  };
}

describe("npm", () => {
  it("verifies against registry dist.integrity and stores the tarball", async () => {
    const fetchOnce = fakeFetch({});
    const input = await npmInput({ fetchOnce });
    const result = await verifyIntegrationPluginPackage(input);
    expect(result.status).toBe("verified");
    if (result.status !== "verified") return;
    expect(result.integritySource).toBe("registry");
    expect(result.actualIntegrity).toBe(sri(TARBALL));
    expect(result.verifiedAt).toBe(NOW.toISOString());
    expect(result.warnings.map((w) => w.code)).toContain("integrity_not_pinned");
    const hex = createHash("sha512").update(TARBALL).digest("hex").slice(0, 16);
    expect(result.artifactPath).toBe(`integration-plugins/demo-plugin/${hex}.tgz`);
    const stored = path.join(path.dirname(input.pluginStoreRoot), result.artifactPath!);
    expect((await stat(stored)).isFile()).toBe(true);
    if (process.platform !== "win32") expect((await stat(stored)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(stored))).toEqual([`${hex}.tgz`]);
    expect(fetchOnce.calls[0]).toBe("https://registry.npmjs.org/pkg/1.0.0");
  });

  it("builds a scoped metadata URL with @ restored", async () => {
    const fetchOnce = fakeFetch({});
    await verifyIntegrationPluginPackage(await npmInput({ fetchOnce, source: "@scope/name" }));
    expect(fetchOnce.calls[0]).toBe("https://registry.npmjs.org/@scope%2Fname/latest");
  });

  it("an operator-pinned expectedIntegrity match is integritySource operator", async () => {
    const result = await verifyIntegrationPluginPackage(
      await npmInput({ fetchOnce: fakeFetch({}), expectedIntegrity: sri(TARBALL) }),
    );
    expect(result.status).toBe("verified");
    if (result.status === "verified") {
      expect(result.integritySource).toBe("operator");
      expect(result.warnings.map((w) => w.code)).not.toContain("integrity_not_pinned");
    }
  });

  it("tarball bytes that mismatch the registry integrity are quarantined and nothing is stored", async () => {
    const input = await npmInput({ fetchOnce: fakeFetch({ tarball: Buffer.from("tampered") }) });
    const result = await verifyIntegrationPluginPackage(input);
    expect(result.status).toBe("quarantined");
    expect(result.warnings[0]).toMatchObject({ code: "integrity_mismatch", severity: "critical" });
    expect(result.warnings[0]!.message).toBe(
      "Plugin package bytes do not match the expected integrity. The package was not stored.",
    );
    await expect(stat(input.pluginStoreRoot)).rejects.toThrow();
  });

  it("bytes matching the registry but not the operator value are quarantined", async () => {
    const input = await npmInput({ fetchOnce: fakeFetch({}), expectedIntegrity: sri(Buffer.from("other")) });
    const result = await verifyIntegrationPluginPackage(input);
    expect(result.status).toBe("quarantined");
    if (result.status === "quarantined") expect(result.expectedIntegrity).toBe(input.expectedIntegrity);
    await expect(stat(input.pluginStoreRoot)).rejects.toThrow();
  });

  it("registry host absent from the allowlist -> no fetch, status unknown, integrity_unverifiable", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const input = await npmInput({ networkAllowlist: [], fetchOnce: fetchAllowlistedOnce });
    const result = await verifyIntegrationPluginPackage(input);
    expect(spy).not.toHaveBeenCalled();
    expect(result.status).toBe("unknown");
    expect(result.warnings[0]).toMatchObject({ code: "integrity_unverifiable", severity: "critical" });
    await expect(stat(input.pluginStoreRoot)).rejects.toThrow();
  });

  it("a tarball URL off the registry host is refused", async () => {
    const fetchOnce = fakeFetch({ tarballUrl: "https://evil.example.com/pkg.tgz" });
    const result = await verifyIntegrationPluginPackage(await npmInput({ fetchOnce }));
    expect(result.status).toBe("unknown");
    expect(result.warnings[0]!.code).toBe("integrity_registry_invalid");
    expect(fetchOnce.calls).toHaveLength(1);
  });

  it("a non-https tarball URL or non-sha512 registry integrity is refused", async () => {
    const http = await verifyIntegrationPluginPackage(
      await npmInput({ fetchOnce: fakeFetch({ tarballUrl: "http://registry.npmjs.org/p.tgz" }) }),
    );
    expect(http.warnings[0]!.code).toBe("integrity_registry_invalid");
    const sha1 = await verifyIntegrationPluginPackage(
      await npmInput({ fetchOnce: fakeFetch({ integrity: "sha1-abc=" }) }),
    );
    expect(sha1.warnings[0]!.code).toBe("integrity_registry_invalid");
  });

  it("a failing fetch is unknown, not thrown", async () => {
    const fetchOnce = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetchAllowlistedOnce;
    const result = await verifyIntegrationPluginPackage(await npmInput({ fetchOnce }));
    expect(result.status).toBe("unknown");
    expect(result.warnings[0]!.code).toBe("integrity_unverifiable");
  });
});

describe("verifyIntegrationPluginPackage review carry-overs", () => {
  it("rejects an unsafe pluginId before any fetch", async () => {
    const fetchOnce = fakeFetch({});
    await expect(
      verifyIntegrationPluginPackage(await npmInput({ fetchOnce, pluginId: "../escape" })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchOnce.calls).toHaveLength(0);
  });

  it("names a short non-secret cause in the unverifiable warning", async () => {
    const notFound = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetchAllowlistedOnce;
    const result = await verifyIntegrationPluginPackage(await npmInput({ fetchOnce: notFound }));
    expect(result.warnings[0]!.message).toContain("registry_status_404");
    const blocked = (async () => {
      throw new Error("host is not in the network allowlist");
    }) as unknown as typeof fetchAllowlistedOnce;
    const second = await verifyIntegrationPluginPackage(await npmInput({ fetchOnce: blocked }));
    expect(second.warnings[0]!.message).toContain("registry_blocked");
  });
});

describe("plugin store location", () => {
  it("stores when an ANCESTOR of the store root is a link (/var, /home, volumes)", async (ctx) => {
    const base = await tmp();
    await mkdir(path.join(base, "real"));
    try {
      await symlink(path.join(base, "real"), path.join(base, "link"), "junction");
    } catch {
      ctx.skip();
      return;
    }
    const input = await npmInput({
      fetchOnce: fakeFetch({}),
      pluginStoreRoot: path.join(base, "link", "data", "integration-plugins"),
    });
    const result = await verifyIntegrationPluginPackage(input);
    expect(result.status).toBe("verified");
    if (result.status === "verified")
      expect(result.artifactPath).toMatch(/^integration-plugins\/demo-plugin\/[0-9a-f]{16}\.tgz$/u);
  });

  it("still refuses a plugin directory that is itself a link", async (ctx) => {
    const base = await tmp();
    const store = path.join(base, "integration-plugins");
    await mkdir(store, { recursive: true });
    await mkdir(path.join(base, "elsewhere"));
    try {
      await symlink(path.join(base, "elsewhere"), path.join(store, "demo-plugin"), "junction");
    } catch {
      ctx.skip();
      return;
    }
    await expect(
      verifyIntegrationPluginPackage(await npmInput({ fetchOnce: fakeFetch({}), pluginStoreRoot: store })),
    ).rejects.toThrow(/ordinary directories/u);
    expect(await readdir(path.join(base, "elsewhere"))).toEqual([]);
  });
});

describe("local source classification", () => {
  it("a missing path is unknown/critical with manifest_path_missing, not quarantined", async () => {
    const result = await verifyIntegrationPluginPackage({
      pluginId: "p",
      source: path.join(await tmp(), "nope"),
      sourceType: "local",
      networkAllowlist: [],
      pluginStoreRoot: path.join(await tmp(), "integration-plugins"),
    });
    expect(result.status).toBe("unknown");
    expect(result.warnings[0]).toMatchObject({ severity: "critical" });
    expect(result.warnings[0]!.message).toContain("manifest_path_missing");
  });

  it("a plain file is unknown with manifest_not_directory", async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, "f.js"), "1");
    const result = await verifyIntegrationPluginPackage({
      pluginId: "p",
      source: path.join(dir, "f.js"),
      sourceType: "local",
      networkAllowlist: [],
      pluginStoreRoot: path.join(dir, "integration-plugins"),
    });
    expect(result.status).toBe("unknown");
    expect(result.warnings[0]!.message).toContain("manifest_not_directory");
  });
});

describe("parsers", () => {
  it("parseNpmPackageSpec handles scoped and versioned specs", () => {
    expect(parseNpmPackageSpec("npm:@s/n@1.2.3")).toEqual({ name: "@s/n", version: "1.2.3" });
    expect(parseNpmPackageSpec("@s/n")).toEqual({ name: "@s/n" });
    expect(parseNpmPackageSpec("n@1")).toEqual({ name: "n", version: "1" });
    expect(parseNpmPackageSpec("n")).toEqual({ name: "n" });
    expect(parseNpmPackageSpec("")).toBeUndefined();
    expect(parseNpmPackageSpec("npm:")).toBeUndefined();
  });

  it("parseSriIntegrity accepts a single well-formed token only", () => {
    const good = sri(TARBALL);
    expect(parseSriIntegrity(good)?.algorithm).toBe("sha512");
    expect(parseSriIntegrity(`${good} ${good}`)).toBeUndefined();
    expect(parseSriIntegrity("sha512-abc")).toBeUndefined();
    expect(parseSriIntegrity("md5-abc=")).toBeUndefined();
  });

  it("a malformed expectedIntegrity throws ValidationError", async () => {
    const message =
      "expectedIntegrity must be a single sha512-<base64> (npm) or sha256-<base64> (local manifest) value";
    const fetchOnce = fakeFetch({});
    for (const bad of ["nonsense", `${sri(TARBALL)} ${sri(TARBALL)}`, sri256("wrong algorithm for npm")]) {
      await expect(
        verifyIntegrationPluginPackage(await npmInput({ fetchOnce, expectedIntegrity: bad })),
      ).rejects.toThrow(message);
    }
    await expect(
      verifyIntegrationPluginPackage(await npmInput({ fetchOnce, expectedIntegrity: "nonsense" })),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchOnce.calls).toHaveLength(0);
  });
});

describe("local", () => {
  async function tree(files: Array<[string, string]>): Promise<string> {
    const dir = await tmp();
    for (const [rel, body] of files) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), body);
    }
    return dir;
  }

  it("manifest hash is deterministic across creation order and changes when one byte changes", async () => {
    const a = await tree([
      ["a.js", "1"],
      ["sub/b.js", "2"],
    ]);
    const b = await tree([
      ["sub/b.js", "2"],
      ["a.js", "1"],
    ]);
    const c = await tree([
      ["a.js", "1"],
      ["sub/b.js", "3"],
    ]);
    const ha = await computeLocalPluginManifestIntegrity(a);
    expect(ha).toMatch(/^sha256-/);
    expect(await computeLocalPluginManifestIntegrity(b)).toBe(ha);
    expect(await computeLocalPluginManifestIntegrity(c)).not.toBe(ha);
  });

  it("skips node_modules and .git", async () => {
    const a = await tree([["a.js", "1"]]);
    const b = await tree([
      ["a.js", "1"],
      ["node_modules/x/i.js", "z"],
      [".git/HEAD", "q"],
    ]);
    expect(await computeLocalPluginManifestIntegrity(b)).toBe(await computeLocalPluginManifestIntegrity(a));
  });

  it("expected match -> verified, mismatch -> quarantined, absent -> not_applicable with the hash", async () => {
    const dir = await tree([["a.js", "1"]]);
    const hash = await computeLocalPluginManifestIntegrity(dir);
    const base = {
      pluginId: "local-plugin",
      source: dir,
      sourceType: "local" as const,
      networkAllowlist: [],
      pluginStoreRoot: path.join(await tmp(), "integration-plugins"),
      now: () => NOW,
    };
    const ok = await verifyIntegrationPluginPackage({ ...base, expectedIntegrity: hash });
    expect(ok).toMatchObject({ status: "verified", integritySource: "operator", actualIntegrity: hash });
    const wrong = sri256("x");
    const bad = await verifyIntegrationPluginPackage({ ...base, expectedIntegrity: wrong });
    expect(bad).toMatchObject({ status: "quarantined", actualIntegrity: hash, expectedIntegrity: wrong });
    expect(bad.warnings[0]!.code).toBe("integrity_mismatch");
    const none = await verifyIntegrationPluginPackage(base);
    expect(none).toMatchObject({ status: "not_applicable", actualIntegrity: hash });
  });

  it("a symlink inside the tree -> quarantined integrity_manifest_invalid", async (ctx) => {
    const dir = await tree([["a.js", "1"]]);
    await mkdir(path.join(dir, "real"));
    try {
      await symlink(path.join(dir, "real"), path.join(dir, "link"), "junction");
    } catch {
      try {
        await symlink(path.join(dir, "a.js"), path.join(dir, "link.js"));
      } catch {
        ctx.skip(); // neither a junction nor a symlink can be created on this host
        return;
      }
    }
    const result = await verifyIntegrationPluginPackage({
      pluginId: "p",
      source: dir,
      sourceType: "local",
      networkAllowlist: [],
      pluginStoreRoot: path.join(await tmp(), "integration-plugins"),
      expectedIntegrity: sri256("x"),
    });
    expect(result.status).toBe("quarantined");
    expect(result.warnings[0]).toMatchObject({ code: "integrity_manifest_invalid", severity: "critical" });
  });

  it("a hardlinked file is rejected", async () => {
    const dir = await tree([["a.js", "1"]]);
    await link(path.join(dir, "a.js"), path.join(dir, "b.js"));
    await expect(computeLocalPluginManifestIntegrity(dir)).rejects.toThrow(/link/i);
  });
});

describe("git/url/manual", () => {
  it.each(["git", "url", "manual", "unknown"] as const)(
    "%s stays unknown with integrity_not_verified",
    async (sourceType) => {
      const fetchOnce = fakeFetch({});
      const result = await verifyIntegrationPluginPackage({
        pluginId: "p",
        source: "https://example.com/x",
        sourceType,
        networkAllowlist: [REGISTRY],
        pluginStoreRoot: path.join(await tmp(), "integration-plugins"),
        fetchOnce,
      });
      expect(result.status).toBe("unknown");
      expect(result.warnings).toContainEqual({
        code: "integrity_not_verified",
        severity: "warning",
        message: "Integrity is not verified for git, URL or manual plugin sources.",
      });
      expect(fetchOnce.calls).toHaveLength(0);
    },
  );
});
