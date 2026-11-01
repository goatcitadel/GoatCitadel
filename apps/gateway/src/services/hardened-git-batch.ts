import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitTreeWording } from "./hardened-git-wording.js";

// The batched blob reader behind `materializeBoundedGitTree` in `hardened-git.ts`: every blob's size in one
// `cat-file --batch-check`, then every blob's content in one `cat-file --batch`. It holds no Git settings of its own:
// the hardened arguments, environment and time limit come in with the runner, so the two files cannot disagree.

const execFileAsync = promisify(execFile);

/** The most one `cat-file` batch frame adds around a blob's content: "<oid> blob <size>\n" before it, "\n" after. */
const GIT_BATCH_FRAME_OVERHEAD_BYTES = 128;
const GIT_BLOB_SIZE_PATTERN = /^(?:0|[1-9]\d*)$/u;

export interface BatchTreeFile {
  objectId: string;
  relativePath: string;
  bytes: number;
}

/** One local `git` command with `input` on its standard input; its standard output comes back as bytes. */
export type GitBatchRunner = (
  args: string[],
  input: string,
  options: { signal: AbortSignal; maxBuffer: number },
) => Promise<Buffer>;

/** What a batch read is held to and how it reports a breach: the limits, the caller's error classes and its words. */
export interface GitBatchRules {
  maxFileBytes: number;
  maxTotalBytes: number;
  limitError: new (message: string) => Error;
  failedError: new (message: string) => Error;
  words: GitTreeWording;
}

/** How a runner starts Git: the full argument prefix (hardened config), the scrubbed environment, the time limit. */
export interface GitInputCommand {
  cwd: string;
  configArgs: readonly string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/**
 * Builds a runner for one local `git` command with `input` on its standard input, under the caller's hardened
 * settings, environment and time limit, and the caller's shared deadline.
 */
export function createGitBatchRunner(command: GitInputCommand): GitBatchRunner {
  return async (args, input, options) => {
    const pending = execFileAsync("git", [...command.configArgs, ...args], {
      cwd: command.cwd,
      windowsHide: true,
      env: command.env,
      signal: options.signal,
      timeout: command.timeoutMs,
      maxBuffer: options.maxBuffer,
      encoding: "buffer",
    });
    // Git can exit before it has read all of its input. That failure comes back through `pending`, not the pipe.
    pending.child.stdin?.on("error", () => undefined);
    pending.child.stdin?.end(input);
    const { stdout } = await pending;
    return stdout;
  };
}

/** What `cat-file --batch` and `--batch-check` are asked for: one object id a line. */
function gitBatchRequest(files: readonly BatchTreeFile[]): string {
  return files.map((file) => `${file.objectId}\n`).join("");
}

/** Every listed file with its size, each held to the per-file limit and all of them to the total, before any read. */
export async function readBoundedBlobSizes<T extends BatchTreeFile>(
  run: GitBatchRunner,
  signal: AbortSignal,
  files: readonly T[],
  rules: GitBatchRules,
): Promise<T[]> {
  const { maxTotalBytes, limitError, failedError, words } = rules;
  const output = await run(["cat-file", "--batch-check"], gitBatchRequest(files), {
    signal,
    maxBuffer: files.length * GIT_BATCH_FRAME_OVERHEAD_BYTES,
  });
  const lines = output.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== files.length) throw new failedError(words.listingUnreadable);
  let totalBytes = 0;
  return files.map((file, index) => {
    const bytes = parseBlobSizeLine(lines[index]!, file, rules);
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw new limitError(words.tooManyBytes(maxTotalBytes));
    }
    return { ...file, bytes };
  });
}

/** One `<oid> <type> <size>` line: the blob that was asked for, and a size within the per-file limit. */
function parseBlobSizeLine(line: string, file: BatchTreeFile, rules: GitBatchRules): number {
  const { maxFileBytes, limitError, words } = rules;
  const [objectId, objectType, rawSize, ...rest] = line.split(" ");
  if (
    objectId !== file.objectId ||
    objectType !== "blob" ||
    rest.length > 0 ||
    !GIT_BLOB_SIZE_PATTERN.test(rawSize ?? "")
  ) {
    throw new limitError(words.fileUnavailable(file.relativePath, maxFileBytes));
  }
  const bytes = Number(rawSize);
  if (!Number.isSafeInteger(bytes) || bytes > maxFileBytes) {
    throw new limitError(words.fileTooLarge(file.relativePath, maxFileBytes));
  }
  return bytes;
}

/** Every file's content, in the order asked, each frame matching the size `--batch-check` gave for it. */
export async function readBoundedBlobContents(
  run: GitBatchRunner,
  signal: AbortSignal,
  files: readonly BatchTreeFile[],
  rules: GitBatchRules,
): Promise<Buffer[]> {
  const { maxTotalBytes, failedError, words } = rules;
  const output = await run(["cat-file", "--batch"], gitBatchRequest(files), {
    signal,
    maxBuffer: maxTotalBytes + files.length * GIT_BATCH_FRAME_OVERHEAD_BYTES,
  });
  const contents: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const frame = readGitBatchFrame(output, offset, file);
    if (!frame) throw new failedError(words.fileChanged(file.relativePath));
    contents.push(frame.content);
    offset = frame.next;
  }
  if (offset !== output.byteLength) throw new failedError(words.listingUnreadable);
  return contents;
}

/** The frame at `offset`, `<oid> blob <size>\n<content>\n`, or nothing when it isn't exactly the one expected. */
function readGitBatchFrame(
  output: Buffer,
  offset: number,
  file: BatchTreeFile,
): { content: Buffer; next: number } | undefined {
  const headerEnd = output.indexOf(0x0a, offset);
  if (headerEnd < 0 || headerEnd - offset > GIT_BATCH_FRAME_OVERHEAD_BYTES) return undefined;
  if (output.toString("latin1", offset, headerEnd) !== `${file.objectId} blob ${file.bytes}`) return undefined;
  const start = headerEnd + 1;
  const end = start + file.bytes;
  if (end >= output.byteLength || output[end] !== 0x0a) return undefined;
  return { content: output.subarray(start, end), next: end + 1 };
}
