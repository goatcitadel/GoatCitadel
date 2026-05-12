import fs from "node:fs";
import path from "node:path";

export interface ReadPathAccessDecision {
  resolvedPath: string;
  withinRoots: boolean;
}

export function assertWritePathInJail(targetPath: string, writeJailRoots: string[]): void {
  const resolvedTarget = resolvePathViaExistingAncestor(targetPath, {
    roots: writeJailRoots,
    scope: "write jail",
  });
  assertWithinRoots(resolvedTarget, writeJailRoots, "write jail");
}

export function assertReadPathAllowed(targetPath: string, writeJailRoots: string[], readOnlyRoots: string[]): void {
  const access = resolveReadPathAccess(targetPath, writeJailRoots, readOnlyRoots);
  if (!access.withinRoots) {
    throw new Error(`Path is outside read allowlist: ${access.resolvedPath}`);
  }
}

export function assertExistingPathRealpathAllowed(
  targetPath: string,
  writeJailRoots: string[],
  readOnlyRoots: string[],
): void {
  const resolvedTarget = fs.realpathSync(path.resolve(targetPath));
  assertWithinRoots(resolvedTarget, [...writeJailRoots, ...readOnlyRoots], "read allowlist");
}

export function resolveReadPathAccess(
  targetPath: string,
  writeJailRoots: string[],
  readOnlyRoots: string[],
): ReadPathAccessDecision {
  const resolvedPath = resolvePathViaExistingAncestor(targetPath);
  return {
    resolvedPath,
    withinRoots: isWithinAnyRoot(resolvedPath, [...writeJailRoots, ...readOnlyRoots]),
  };
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isWithinAnyRoot(target: string, roots: string[]): boolean {
  return roots.some((root) => isWithin(path.resolve(root), target));
}

function matchingLexicalRoots(target: string, roots: string[]): string[] {
  return roots.map((root) => path.resolve(root)).filter((root) => isWithin(root, target));
}

function assertWithinRoots(target: string, roots: string[], scope: string): void {
  const allowed = isWithinAnyRoot(target, roots);
  if (!allowed) {
    throw new Error(`Path is outside ${scope}: ${target}`);
  }
}

function resolvePathViaExistingAncestor(targetPath: string, rootGuard?: { roots: string[]; scope: string }): string {
  const absoluteTarget = path.resolve(targetPath);
  const lexicalRoots = rootGuard ? matchingLexicalRoots(absoluteTarget, rootGuard.roots) : [];

  // Resolve symlinks for the closest existing ancestor so read/write checks
  // cannot escape via links inside an otherwise allowed directory.
  let probe = absoluteTarget;
  while (true) {
    if (fs.existsSync(probe)) {
      const realExisting = fs.realpathSync(probe);
      if (rootGuard) {
        if (!isWithinAnyRoot(realExisting, rootGuard.roots) && canCreateMissingJailRoot(probe, lexicalRoots)) {
          return absoluteTarget;
        }
        assertWithinRoots(realExisting, rootGuard.roots, rootGuard.scope);
      }
      if (probe === absoluteTarget) {
        return realExisting;
      }
      const relativeTail = path.relative(probe, absoluteTarget);
      const resolvedPath = path.resolve(realExisting, relativeTail);
      if (rootGuard) {
        assertWithinRoots(resolvedPath, rootGuard.roots, rootGuard.scope);
      }
      return resolvedPath;
    }

    const parent = path.dirname(probe);
    if (parent === probe) {
      break;
    }
    probe = parent;
  }

  if (rootGuard) {
    assertWithinRoots(absoluteTarget, rootGuard.roots, rootGuard.scope);
  }
  return absoluteTarget;
}

function canCreateMissingJailRoot(existingAncestor: string, lexicalRoots: string[]): boolean {
  return lexicalRoots.some((root) => !isWithin(root, existingAncestor) && isWithin(existingAncestor, root));
}
