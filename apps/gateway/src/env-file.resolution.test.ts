import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWritableEnvFilePath, upsertLocalEnvVar } from "./env-file.js";

/**
 * Resolution-order contract for the credential writer.
 *
 * `.env` is a credential sink, so *where* it resolves is a security property,
 * not a convenience. These tests pin the two rules that keep a secret from
 * landing in someone else's file:
 *
 *   1. An explicit `rootDir` is authoritative — resolution never falls through
 *      to cwd-derived roots, so the write target cannot depend on the working
 *      directory the process happened to start in.
 *   2. Discovery mode (no `rootDir`) walks cwd, cwd/.., cwd/../.. in that
 *      order, preferring a root that carries the config marker.
 */

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("resolveWritableEnvFilePath — resolution order", () => {
  it("treats an explicit rootDir as authoritative and never falls through to a cwd-derived root", async () => {
    const sandbox = await createSandbox();
    // The repo root two levels above cwd carries the marker, and is therefore
    // the target the cwd walk would pick.
    await writeConfigMarker(sandbox.grandparent);
    // The caller names a different install root that has neither marker nor .env.
    const installRoot = path.join(sandbox.base, "install");
    await fs.mkdir(installRoot, { recursive: true });

    withCwd(sandbox.workdir, () => {
      expect(resolveWritableEnvFilePath({ rootDir: installRoot })).toBeUndefined();

      const result = upsertLocalEnvVar("GOATCITADEL_AUTH_TOKEN", "super-secret-token", { rootDir: installRoot });
      expect(result.updated).toBe(false);
    });

    // The decisive assertion: the secret must not have been written into the
    // unrelated repo root that merely happened to be an ancestor of cwd.
    await expect(fs.readFile(path.join(sandbox.grandparent, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("writes to the explicit rootDir even when a cwd-derived root also carries the marker", async () => {
    const sandbox = await createSandbox();
    await writeConfigMarker(sandbox.grandparent);
    const installRoot = path.join(sandbox.base, "install");
    await writeConfigMarker(installRoot);

    withCwd(sandbox.workdir, () => {
      const result = upsertLocalEnvVar("GOATCITADEL_AUTH_TOKEN", "install-token", { rootDir: installRoot });
      expect(result).toMatchObject({ updated: true, path: path.join(installRoot, ".env") });
    });

    await expect(fs.readFile(path.join(sandbox.grandparent, ".env"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ignores GOATCITADEL_ROOT_DIR when an explicit rootDir is supplied", async () => {
    const sandbox = await createSandbox();
    const ambientRoot = path.join(sandbox.base, "ambient");
    await writeConfigMarker(ambientRoot);
    const installRoot = path.join(sandbox.base, "install");
    await writeConfigMarker(installRoot);

    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: ambientRoot }, () => {
        expect(resolveWritableEnvFilePath({ rootDir: installRoot })).toBe(path.join(installRoot, ".env"));
      });
    });
  });

  it("walks cwd, then cwd/.., then cwd/../.. in discovery mode", async () => {
    const sandbox = await createSandbox();
    await writeConfigMarker(sandbox.grandparent);

    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: undefined }, () => {
        // Only the grandparent carries the marker, so the walk reaches it.
        expect(resolveWritableEnvFilePath()).toBe(path.join(sandbox.grandparent, ".env"));
      });
    });

    // A nearer marker wins over a farther one.
    await writeConfigMarker(sandbox.parent);
    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: undefined }, () => {
        expect(resolveWritableEnvFilePath()).toBe(path.join(sandbox.parent, ".env"));
      });
    });

    // cwd's own marker beats every ancestor.
    await writeConfigMarker(sandbox.workdir);
    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: undefined }, () => {
        expect(resolveWritableEnvFilePath()).toBe(path.join(sandbox.workdir, ".env"));
      });
    });
  });

  it("prefers GOATCITADEL_ROOT_DIR over the cwd walk in discovery mode", async () => {
    const sandbox = await createSandbox();
    await writeConfigMarker(sandbox.workdir);
    const ambientRoot = path.join(sandbox.base, "ambient");
    await writeConfigMarker(ambientRoot);

    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: ambientRoot }, () => {
        expect(resolveWritableEnvFilePath()).toBe(path.join(ambientRoot, ".env"));
      });
    });
  });

  it("prefers any marker-carrying root over a nearer root that only has a bare .env", async () => {
    const sandbox = await createSandbox();
    await fs.writeFile(path.join(sandbox.workdir, ".env"), "EXISTING=1\n", "utf8");
    await writeConfigMarker(sandbox.grandparent);

    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: undefined }, () => {
        expect(resolveWritableEnvFilePath()).toBe(path.join(sandbox.grandparent, ".env"));
      });
    });
  });

  it("falls back to a bare .env only when no candidate carries the marker", async () => {
    const sandbox = await createSandbox();
    await fs.writeFile(path.join(sandbox.parent, ".env"), "EXISTING=1\n", "utf8");

    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: undefined }, () => {
        expect(resolveWritableEnvFilePath()).toBe(path.join(sandbox.parent, ".env"));
      });
    });
  });

  it("accepts the example config marker as a repo marker", async () => {
    const sandbox = await createSandbox();
    const installRoot = path.join(sandbox.base, "install");
    await fs.mkdir(path.join(installRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(installRoot, "config", "assistant.config.example.json"), "{}\n", "utf8");

    expect(resolveWritableEnvFilePath({ rootDir: installRoot })).toBe(path.join(installRoot, ".env"));
  });
});

describe("upsertLocalEnvVar — unresolvable target", () => {
  it("reports the probed roots instead of failing silently", async () => {
    const sandbox = await createSandbox();
    const installRoot = path.join(sandbox.base, "install");
    await fs.mkdir(installRoot, { recursive: true });

    const result = upsertLocalEnvVar("GOATCITADEL_AUTH_TOKEN", "super-secret-token", { rootDir: installRoot });

    expect(result.updated).toBe(false);
    if (result.updated) {
      throw new Error("expected the write to fail");
    }
    expect(result.reason).toBe("no-writable-env-file");
    expect(result.probedRoots).toEqual([installRoot]);
  });

  it("lists every cwd-derived candidate it probed in discovery mode", async () => {
    const sandbox = await createSandbox();

    withCwd(sandbox.workdir, () => {
      withEnv({ GOATCITADEL_ROOT_DIR: undefined }, () => {
        const result = upsertLocalEnvVar("SOME_KEY", "value");
        expect(result.updated).toBe(false);
        if (result.updated) {
          throw new Error("expected the write to fail");
        }
        expect(result.probedRoots).toEqual([sandbox.workdir, sandbox.parent, sandbox.grandparent]);
      });
    });
  });
});

interface Sandbox {
  base: string;
  grandparent: string;
  parent: string;
  workdir: string;
}

/**
 * Builds base/grandparent/parent/workdir so that cwd/.. and cwd/../.. stay
 * inside the sandbox — the walk must never escape into the real os.tmpdir(),
 * which may carry a .env on a developer machine.
 */
async function createSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-env-resolution-"));
  tempRoots.push(created);
  const base = await fs.realpath(created);
  const grandparent = path.join(base, "grandparent");
  const parent = path.join(grandparent, "parent");
  const workdir = path.join(parent, "workdir");
  await fs.mkdir(workdir, { recursive: true });
  return { base, grandparent, parent, workdir };
}

async function writeConfigMarker(rootDir: string): Promise<void> {
  await fs.mkdir(path.join(rootDir, "config"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "config", "assistant.config.json"), "{}\n", "utf8");
}

function withCwd(dir: string, callback: () => void): void {
  const priorCwd = process.cwd();
  process.chdir(dir);
  try {
    callback();
  } finally {
    process.chdir(priorCwd);
  }
}

function withEnv(values: Record<string, string | undefined>, callback: () => void): void {
  const previous = new Map<string, string | undefined>(
    Object.keys(values).map((key) => [key, process.env[key]] as const),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
