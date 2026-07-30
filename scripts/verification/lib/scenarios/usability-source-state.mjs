import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SOURCE_MODES = new Set(["exploratory", "final"]);

export function snapshotUsabilitySourceState(repoRoot, requestedMode) {
  const mode = String(requestedMode ?? "final")
    .trim()
    .toLowerCase();
  if (!SOURCE_MODES.has(mode)) {
    throw new Error(`unsupported usability source mode ${mode}; expected exploratory or final`);
  }

  const baseSha = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
  const status = runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const trackedDiff = runGit(repoRoot, ["diff", "--binary", "HEAD", "--"]);
  const untrackedPaths = parseUntrackedPaths(status);
  const hash = createHash("sha256");
  hash.update(status);
  hash.update("\0tracked-diff\0");
  hash.update(trackedDiff);
  for (const relativePath of untrackedPaths.sort()) {
    const absolutePath = path.resolve(repoRoot, relativePath);
    const relativeCheck = path.relative(repoRoot, absolutePath);
    if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
      throw new Error(`untracked usability source path escaped the repository: ${relativePath}`);
    }
    hash.update("\0untracked-path\0");
    hash.update(relativePath.replaceAll("\\", "/"));
    hash.update("\0untracked-bytes\0");
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      hash.update(fs.readlinkSync(absolutePath));
    } else if (stat.isFile()) {
      hash.update(fs.readFileSync(absolutePath));
    } else {
      throw new Error(`untracked usability source path is not a file: ${relativePath}`);
    }
  }

  const sourceModified = status.length > 0;
  const state = {
    mode,
    baseSha,
    sourceModified,
    diffSha256: hash.digest("hex"),
    changedPathCount: countStatusRecords(status),
  };
  assertUsabilitySourceState(state);
  return state;
}

export function assertUsabilitySourceState(state) {
  if (!state || !SOURCE_MODES.has(state.mode)) throw new Error("usability source state has no valid mode");
  if (!/^[a-f0-9]{40}$/u.test(state.baseSha)) throw new Error("usability source state has no full base SHA");
  if (!/^[a-f0-9]{64}$/u.test(state.diffSha256)) throw new Error("usability source state has no diff SHA-256");
  if (state.mode === "final" && state.sourceModified) {
    throw new Error(
      "final usability verification requires a clean source tree; set GOATCITADEL_USABILITY_SOURCE_MODE=exploratory only for explicitly non-final discovery runs",
    );
  }
}

export function assertUsabilitySourceStateUnchanged(started, completed) {
  assertUsabilitySourceState(started);
  const comparedFields = ["mode", "baseSha", "sourceModified", "diffSha256", "changedPathCount"];
  const changedFields = comparedFields.filter((field) => completed?.[field] !== started[field]);
  if (changedFields.length > 0) {
    throw new Error(`usability source changed during verification (${changedFields.join(", ")})`);
  }
  assertUsabilitySourceState(completed);
  return completed;
}

function runGit(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: args.includes("-z") ? "buffer" : "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function parseUntrackedPaths(statusBuffer) {
  return parseStatusEntries(statusBuffer)
    .filter((entry) => entry.status === "??")
    .map((entry) => entry.relativePath);
}

function countStatusRecords(statusBuffer) {
  return parseStatusEntries(statusBuffer).length;
}

function parseStatusEntries(statusBuffer) {
  const records = splitStatusRecords(statusBuffer);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4 || record[2] !== 32) throw new Error("git status returned a malformed source record");
    const status = record.subarray(0, 2).toString("utf8");
    const relativePath = record.subarray(3).toString("utf8");
    const renamedOrCopied = status.includes("R") || status.includes("C");
    let originalPath;
    if (renamedOrCopied) {
      index += 1;
      if (index >= records.length) throw new Error(`git status omitted the source path for ${relativePath}`);
      originalPath = records[index].toString("utf8");
    }
    entries.push({ status, relativePath, originalPath });
  }
  return entries;
}

function splitStatusRecords(statusBuffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < statusBuffer.length; index += 1) {
    if (statusBuffer[index] !== 0) continue;
    if (index > start) records.push(statusBuffer.subarray(start, index));
    start = index + 1;
  }
  if (start < statusBuffer.length) records.push(statusBuffer.subarray(start));
  return records;
}
