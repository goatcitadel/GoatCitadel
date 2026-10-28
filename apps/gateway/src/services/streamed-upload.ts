import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { PayloadTooLargeError, ValidationError } from "@goatcitadel/contracts";

/** Gateway-owned folder, inside the workspace, where an upload's bytes land before they move into place. */
export const UPLOAD_STAGING_DIR_NAME = ".goatcitadel-uploads";
const STAGING_SUFFIX = ".upload";
const STALE_STAGING_MS = 60 * 60_000;
const HEAD_BYTES = 16 * 1024;
const MOVE_RETRY_DELAYS_MS = [50, 150, 400];

export interface StagedUpload {
  stagingPath: string;
  bytes: number;
  sha256: string;
  /** The first 16 KB, for sniffing or previews without re-reading the file. */
  head: Buffer;
}

export interface ReceiveUploadOptions {
  stagingDir: string;
  maxBytes: number;
  /** The request's Content-Length; the body must be exactly this long. */
  declaredBytes: number;
  /** Lower-case hex SHA-256 the client claims for the body; checked after the last byte. */
  expectedSha256?: string;
  /** Sees every chunk in order. Throwing rejects the upload once the body has been drained. */
  inspect?: (chunk: Buffer) => void;
  /** Runs after the last chunk. Throwing rejects the upload. */
  finish?: () => void;
}

export function isStreamedRequestBody(body: unknown): body is Readable {
  return body instanceof Readable;
}

/**
 * Streams a request body into a fresh staging file, counting and hashing as it goes, so the Gateway never holds the
 * whole upload. A rejected chunk does not tear the request down: the rest of the body is drained and discarded, so
 * the client still receives the error response. The staging file is removed on every failure.
 */
export async function receiveUpload(body: Readable, options: ReceiveUploadOptions): Promise<StagedUpload> {
  if (options.declaredBytes > options.maxBytes) {
    throw new PayloadTooLargeError("File upload exceeds the configured workspace upload limit", {
      limitBytes: options.maxBytes,
      receivedBytes: options.declaredBytes,
    });
  }
  await fs.mkdir(options.stagingDir, { recursive: true });
  await sweepStaleStagingFiles(options.stagingDir);
  const stagingPath = path.join(options.stagingDir, `${randomUUID()}${STAGING_SUFFIX}`);
  const hash = createHash("sha256");
  const headChunks: Buffer[] = [];
  let headLength = 0;
  let received = 0;
  let failure: unknown;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (failure !== undefined) return callback();
      received += chunk.length;
      if (received > options.declaredBytes || received > options.maxBytes) {
        failure = new PayloadTooLargeError("File upload is longer than its declared length", {
          limitBytes: Math.min(options.declaredBytes, options.maxBytes),
        });
        return callback();
      }
      try {
        options.inspect?.(chunk);
      } catch (error) {
        failure = error;
        return callback();
      }
      hash.update(chunk);
      if (headLength < HEAD_BYTES) {
        const slice = chunk.subarray(0, HEAD_BYTES - headLength);
        headChunks.push(Buffer.from(slice));
        headLength += slice.length;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(stagingPath, { flags: "wx" }));
    if (failure !== undefined) throw failure;
    if (received !== options.declaredBytes) {
      throw new ValidationError({ message: "File upload ended before its declared length." });
    }
    options.finish?.();
    const sha256 = hash.digest("hex");
    if (options.expectedSha256 && options.expectedSha256 !== sha256) {
      throw new ValidationError({
        field: "x-content-sha256",
        message: "File upload does not match its declared SHA-256.",
      });
    }
    return { stagingPath, bytes: received, sha256, head: Buffer.concat(headChunks) };
  } catch (error) {
    await fs.rm(stagingPath, { force: true });
    throw error;
  }
}

/**
 * Moves a staged upload to its target and always removes the staging file. With `expectAbsent`, a hard link creates
 * the target atomically, so a file that appeared since the review is never replaced ("exists" is returned instead).
 * An existing file is rewritten in place, as `fs.writeFile` did, so its mode, ACLs and hard links survive.
 *
 * `assertTarget` runs after the parent folder exists and immediately before the file operation: an upload can take
 * minutes, and a check made before it started says nothing about a parent swapped for a symlink meanwhile.
 */
export async function commitStagedUpload(
  stagingPath: string,
  targetPath: string,
  options: { expectAbsent?: boolean; assertTarget?: () => void } = {},
): Promise<"written" | "exists"> {
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    options.assertTarget?.();
    if (options.expectAbsent) {
      try {
        await withMoveRetries(() => fs.link(stagingPath, targetPath));
      } catch (error) {
        const code = errorCode(error);
        if (code === "EEXIST") return "exists";
        // Some volumes refuse hard links; an exclusive copy keeps the same guarantee.
        if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP") throw error;
        try {
          await fs.copyFile(stagingPath, targetPath, fsConstants.COPYFILE_EXCL);
        } catch (copyError) {
          if (errorCode(copyError) === "EEXIST") return "exists";
          throw copyError;
        }
      }
      return "written";
    }
    const existing = await fs.lstat(targetPath).catch(() => undefined);
    if (existing?.isFile()) {
      await pipeline(createReadStream(stagingPath), createWriteStream(targetPath, { flags: "w" }));
      return "written";
    }
    try {
      await withMoveRetries(() => fs.rename(stagingPath, targetPath));
    } catch (error) {
      if (errorCode(error) !== "EXDEV") throw error;
      await fs.copyFile(stagingPath, targetPath);
    }
    return "written";
  } finally {
    await fs.rm(stagingPath, { force: true });
  }
}

/** Antivirus and the Windows indexer can briefly hold a fresh file; retry a move before giving up. */
async function withMoveRetries(move: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await move();
    } catch (error) {
      const code = errorCode(error);
      const transient = code === "EBUSY" || code === "EACCES" || (code === "EPERM" && process.platform === "win32");
      const wait = MOVE_RETRY_DELAYS_MS[attempt];
      if (!transient || wait === undefined) throw error;
      await delay(wait);
    }
  }
}

/** Best effort: removes staging files a crashed or killed Gateway left behind. */
async function sweepStaleStagingFiles(stagingDir: string): Promise<void> {
  const cutoff = Date.now() - STALE_STAGING_MS;
  const names = await fs.readdir(stagingDir).catch((): string[] => []);
  await Promise.all(
    names
      .filter((name) => name.endsWith(STAGING_SUFFIX))
      .map(async (name) => {
        const full = path.join(stagingDir, name);
        const stat = await fs.stat(full).catch(() => undefined);
        if (stat && stat.mtimeMs < cutoff) await fs.rm(full, { force: true }).catch(() => undefined);
      }),
  );
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
