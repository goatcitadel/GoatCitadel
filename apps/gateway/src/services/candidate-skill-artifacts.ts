import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { ConflictError } from "@goatcitadel/contracts";
import { assertWritePathInJail } from "@goatcitadel/policy-engine";
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export async function writeImmutableBundle(root: string, bundle: string, files: Record<string, string>): Promise<void> {
  assertWritePathInJail(bundle, [root]);
  await fs.mkdir(root, { recursive: true });
  for (const directory of [root, path.dirname(bundle), bundle]) {
    await fs.mkdir(directory, { recursive: true });
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new ConflictError({ message: "Capture artifact directory is not a real directory." });
    assertWritePathInJail(directory, [root]);
  }
  for (const [name, content] of Object.entries(files)) {
    const expectedBytes = Buffer.byteLength(content);
    if (expectedBytes > 128 * 1024) throw new ConflictError({ message: "Capture artifact exceeds its size limit." });
    const target = path.join(bundle, name);
    assertWritePathInJail(target, [root]);
    let created: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      created = await fs.open(target, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (created) {
      try {
        await created.writeFile(content, "utf8");
        await created.sync();
      } finally {
        await created.close();
      }
    }
    const stat = await fs.lstat(target);
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
