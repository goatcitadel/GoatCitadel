import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertReadPathAllowed, assertWritePathInJail } from "./sandbox/path-jail.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("assertWritePathInJail", () => {
  it("allows writes in jail", () => {
    expect(() => assertWritePathInJail("./workspace/file.txt", ["./workspace"])).not.toThrow();
  });

  it("blocks traversal outside jail", () => {
    expect(() => assertWritePathInJail("./workspace/../secret.txt", ["./workspace"])).toThrow(/outside write jail/i);
  });

  it("allows writes under a configured jail root that does not exist yet", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-path-jail-missing-root-"));
    tempDirs.push(root);

    const jailRoot = path.join(root, "workspace");
    const attemptedWritePath = path.join(jailRoot, "verification", "proof.md");

    expect(() => assertWritePathInJail(attemptedWritePath, [jailRoot])).not.toThrow();
  });

  it("still blocks siblings of a missing configured jail root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-path-jail-missing-root-"));
    tempDirs.push(root);

    const jailRoot = path.join(root, "workspace");
    const attemptedWritePath = path.join(root, "workspace-sibling", "proof.md");

    expect(() => assertWritePathInJail(attemptedWritePath, [jailRoot])).toThrow(/outside write jail/i);
  });

  it("blocks writes through symlink escape paths", () => {
    const fixture = createSymlinkFixture();
    if (!fixture) {
      return;
    }

    const attemptedWritePath = path.join(fixture.jailRoot, "link-out", "pwned.txt");
    expect(() => assertWritePathInJail(attemptedWritePath, [fixture.jailRoot])).toThrow(/outside write jail/i);
  });

  it("blocks missing write targets when an existing symlink ancestor escapes the jail", () => {
    const fixture = createSymlinkFixture();
    if (!fixture) {
      return;
    }

    const attemptedWritePath = path.join(fixture.jailRoot, "link-out", "missing", "pwned.txt");
    expect(() => assertWritePathInJail(attemptedWritePath, [fixture.jailRoot])).toThrow(/outside write jail/i);
  });
});

describe("assertReadPathAllowed", () => {
  it("blocks reads through symlink escape paths", () => {
    const fixture = createSymlinkFixture();
    if (!fixture) {
      return;
    }

    const escapedFile = path.join(fixture.jailRoot, "link-out", "secret.txt");
    expect(() => assertReadPathAllowed(escapedFile, [fixture.jailRoot], [])).toThrow(/outside read allowlist/i);
  });

  it("blocks nonexistent absolute paths outside the allowlist before filesystem access", () => {
    const fixture = createSymlinkFixture();
    if (!fixture) {
      return;
    }

    const missingOutsidePath = path.join(path.dirname(fixture.jailRoot), "outside-missing", "ghost.txt");
    expect(() => assertReadPathAllowed(missingOutsidePath, [fixture.jailRoot], [])).toThrow(/outside read allowlist/i);
  });
});

function createSymlinkFixture(): { jailRoot: string } | undefined {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-path-jail-"));
  tempDirs.push(root);

  const jailRoot = path.join(root, "jail");
  const outsideRoot = path.join(root, "outside");
  fs.mkdirSync(jailRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
  fs.writeFileSync(path.join(outsideRoot, "secret.txt"), "secret", "utf8");

  const linkPath = path.join(jailRoot, "link-out");
  try {
    fs.symlinkSync(outsideRoot, linkPath, "junction");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return undefined;
    }
    throw error;
  }

  return { jailRoot };
}
