import fs from "node:fs";
import path from "node:path";

export function assertWritePathInJail(targetPath: string, writeJailRoots: string[]): void {
  const resolvedTarget = resolvePathViaExistingAncestor(targetPath);
  assertWithinRoots(resolvedTarget, writeJailRoots, "write jail");
}

export function assertReadPathAllowed(
  targetPath: string,
  writeJailRoots: string[],
  readOnlyRoots: string[],
): void {
  const resolvedTarget = resolvePathViaExistingAncestor(targetPath);
  assertWithinRoots(resolvedTarget, [...writeJailRoots, ...readOnlyRoots], "read allowlist");
}

export function assertExistingPathRealpathAllowed(
  targetPath: string,
  writeJailRoots: string[],
  readOnlyRoots: string[],
): void {
  const resolvedTarget = fs.realpathSync(path.resolve(targetPath));
  assertWithinRoots(resolvedTarget, [...writeJailRoots, ...readOnlyRoots], "read allowlist");
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertWithinRoots(target: string, roots: string[], scope: string): void {
  const allowed = roots.some((root) => isWithin(path.resolve(root), target));
  if (!allowed) {
    throw new Error(`Path is outside ${scope}: ${target}`);
  }
}

function resolvePathViaExistingAncestor(targetPath: string): string {
  const absoluteTarget = path.resolve(targetPath);

  // Resolve symlinks for the closest existing ancestor so read/write checks
  // cannot escape via links inside an otherwise allowed directory.
  let probe = absoluteTarget;
  while (true) {
    if (fs.existsSync(probe)) {
      const realExisting = fs.realpathSync(probe);
      if (probe === absoluteTarget) {
        return realExisting;
      }
      const relativeTail = path.relative(probe, absoluteTarget);
      return path.resolve(realExisting, relativeTail);
    }

    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }

  return absoluteTarget;
}
