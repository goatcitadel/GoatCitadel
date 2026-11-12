import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ConflictError } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function writeImmutableBundle(root: string, bundle: string, files: Record<string, string>): Promise<void> {
  assertWritePathInJail(bundle, [root]);
  const parent = path.dirname(bundle);
  for (const directory of [root, parent]) {
    await fs.mkdir(directory, { recursive: true });
    await readCaptureDirectory(root, directory);
  }
  for (const [name, content] of Object.entries(files)) {
    if (Buffer.byteLength(content) > 128 * 1024)
      throw new ConflictError({ message: "Capture artifact exceeds its size limit." });
    assertWritePathInJail(path.join(bundle, name), [bundle]);
  }
  if (!(await readCaptureDirectory(root, bundle))) {
    await publishCaptureDirectory(root, parent, bundle, files);
  }
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(bundle, name);
    assertWritePathInJail(target, [root]);
    const expectedBytes = Buffer.byteLength(content);
    const stat = await lstatIfPresent(target);
    if (!stat) {
      throw new ConflictError({ message: "Existing capture bundle is incomplete. Prepare a new skill draft." });
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== expectedBytes) {
      throw new ConflictError({ message: "Existing capture artifact does not match the reviewed immutable bytes." });
    }
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const held = await handle.stat();
      if (
        !held.isFile() ||
        held.ino !== stat.ino ||
        held.dev !== stat.dev ||
        held.nlink !== 1 ||
        held.size !== expectedBytes
      )
        throw new ConflictError({ message: "Capture artifact file identity changed." });
      const bytes = Buffer.alloc(expectedBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (
        length !== expectedBytes ||
        after.size !== held.size ||
        after.mtimeMs !== held.mtimeMs ||
        after.ctimeMs !== held.ctimeMs ||
        sha256(bytes.subarray(0, length)) !== sha256(content)
      )
        throw new ConflictError({ message: "Existing capture artifact does not match the reviewed immutable bytes." });
    } finally {
      await handle.close();
    }
  }
}

function lstatIfPresent(target: string): Promise<Stats | undefined> {
  return fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function readCaptureDirectory(root: string, directory: string): Promise<Stats | undefined> {
  assertWritePathInJail(directory, [root]);
  const stat = await lstatIfPresent(directory);
  if (stat && !stat.isDirectory()) {
    throw new ConflictError({ message: "Capture artifact directory is not a real directory." });
  }
  return stat;
}

async function publishCaptureDirectory(
  root: string,
  parent: string,
  bundle: string,
  files: Record<string, string>,
): Promise<void> {
  const staging = await fs.mkdtemp(path.join(parent, ".capture-"));
  const stagingIdentity = await fs.lstat(staging);
  const created = new Map<string, Stats>();
  let published = false;
  try {
    for (const [name, content] of Object.entries(files)) {
      const target = path.join(staging, name);
      assertWritePathInJail(target, [staging]);
      const handle = await fs.open(target, "wx", 0o600);
      try {
        created.set(target, await handle.stat());
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await assertCaptureStagingIdentity(root, staging, stagingIdentity);
    assertWritePathInJail(bundle, [root]);
    try {
      // Publish all files together. Rename cannot replace a nonempty bundle,
      // so a simultaneous writer's winner is verified against the same bytes.
      await fs.rename(staging, bundle);
      published = true;
    } catch (error) {
      if (!(await readCaptureDirectory(root, bundle))) throw error;
    }
  } finally {
    if (!published) await cleanupCaptureDirectory(root, staging, stagingIdentity, created);
  }
}

async function cleanupCaptureDirectory(
  root: string,
  staging: string,
  stagingIdentity: Stats,
  created: ReadonlyMap<string, Stats>,
): Promise<void> {
  for (const [target, identity] of created) {
    await assertCaptureStagingIdentity(root, staging, stagingIdentity);
    assertWritePathInJail(target, [staging]);
    const current = await lstatIfPresent(target);
    if (!current) continue;
    if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new ConflictError({ message: "Capture staging file identity changed before cleanup." });
    }
    await fs.unlink(target);
  }
  await assertCaptureStagingIdentity(root, staging, stagingIdentity);
  await fs.rmdir(staging);
}

async function assertCaptureStagingIdentity(root: string, staging: string, identity: Stats): Promise<void> {
  const current = await readCaptureDirectory(root, staging);
  if (!current || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new ConflictError({ message: "Capture staging directory identity changed." });
  }
}
