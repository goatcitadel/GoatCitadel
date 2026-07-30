import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createInflateRaw } from "node:zlib";

const DEFAULT_ARTIFACT_ROOT = path.join(process.cwd(), "artifacts", "verification");
const LATEST_RUN_POINTER_PATH = path.join(DEFAULT_ARTIFACT_ROOT, "latest-run.json");
const STREAM_OVERLAP_CHARS = 4096;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const MAX_ZIP_DIRECTORY_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 100_000;
const MAX_ZIP_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 1024 * 1024 * 1024;

const SECRET_PATTERNS = [
  {
    id: "openai-style-key",
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/i,
  },
  {
    id: "anthropic-style-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/i,
  },
  {
    id: "github-style-token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    id: "authorization-header",
    pattern: /\bAuthorization\s*:\s*(?:Bearer|Basic|ApiKey|Token)\s+\S{8,}/i,
  },
  {
    id: "provider-secret-json",
    // The closing quote is intentionally not required so a streamed scan can
    // identify the minimum secret-shaped prefix even when a value spans chunks.
    pattern: /"(?:apiKey|api_key|authorization|accessToken|access_token)"\s*:\s*"[^"\r\n]{16,}/i,
  },
  {
    id: "database-secret-json",
    // Retained Gateway diagnostics must not serialize a database password or
    // connection string even when it does not use a recognizable URL shape.
    pattern: /"(?:password|connectionString|connection_string)"\s*:\s*"[^"\r\n]{16,}/i,
  },
  {
    id: "provider-secret-env",
    pattern:
      /\b[A-Z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*["']?[^"'\s]{16,}/i,
  },
  {
    id: "provider-secret-url-query",
    pattern: /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret|client_secret)=([^&#\s]{12,})/i,
  },
  {
    id: "database-credential-url",
    pattern: /\bpostgres(?:ql)?:\/\/[^:\s/@]+:[^@\s]+@/i,
  },
];

export async function findArtifactRedactionFindings(rootDir = DEFAULT_ARTIFACT_ROOT) {
  const findings = [];
  let rootStat;
  try {
    rootStat = await fs.stat(rootDir);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return findings;
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    return findings;
  }
  for await (const filePath of walkFiles(rootDir)) {
    const relativeFile = path.relative(rootDir, filePath).replaceAll("\\", "/");
    const ruleIds = await scanArtifactFile(filePath);
    for (const ruleId of ruleIds) {
      findings.push({
        file: relativeFile,
        ruleId,
      });
    }
  }
  return findings;
}

export async function assertArtifactRedactionGate(rootDir) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new Error("artifact redaction gate requires an explicit artifact root");
  }
  const resolvedRoot = path.resolve(rootDir);
  let rootStat;
  try {
    rootStat = await fs.lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      // The filesystem error can contain a sensitive absolute path. Do not retain it as a cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error("artifact redaction gate root does not exist");
    }
    // The filesystem error can contain a sensitive absolute path. Do not retain it as a cause.
    // eslint-disable-next-line preserve-caught-error
    throw new Error("artifact redaction gate root could not be inspected");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("artifact redaction gate root is not a directory");
  }

  let findings;
  try {
    findings = await findArtifactRedactionFindings(resolvedRoot);
  } catch {
    throw new Error("artifact redaction gate could not scan every artifact");
  }
  if (findings.length > 0) {
    const ruleIds = [...new Set(findings.map((item) => item.ruleId))].sort();
    throw new Error(`artifact redaction found ${findings.length} issue(s); rules=${ruleIds.join(",")}`);
  }
  return { artifactRoot: resolvedRoot, findings: 0 };
}

export async function scanArtifactFile(filePath) {
  const matchedRuleIds = new Set();
  try {
    await scanReadableForSecrets(createReadStream(filePath), matchedRuleIds);
  } catch {
    // Evidence that could not be inspected must block the gate. Never include
    // the underlying error because it may itself contain a sensitive path.
    return ["unscanned-file"];
  }

  if (path.extname(filePath).toLowerCase() === ".zip") {
    try {
      await scanZipEntries(filePath, matchedRuleIds);
    } catch {
      // A compressed evidence container that cannot be inspected is itself a
      // gate failure. Do not include parser details or entry names because
      // either may contain sensitive artifact content.
      matchedRuleIds.add("unscanned-archive");
    }
  }

  return [...matchedRuleIds];
}

async function scanReadableForSecrets(readable, matchedRuleIds, options = {}) {
  const decoder = new StringDecoder("utf8");
  let overlap = "";
  let bytesRead = 0;
  const scanWindow = (content) => {
    for (const rule of SECRET_PATTERNS) {
      if (!matchedRuleIds.has(rule.id) && rule.pattern.test(content)) {
        matchedRuleIds.add(rule.id);
      }
    }
    overlap = content.slice(-STREAM_OVERLAP_CHARS);
  };

  for await (const chunk of readable) {
    bytesRead += chunk.length;
    if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
      throw new Error("artifact entry exceeded its bounded scan size");
    }
    scanWindow(overlap + decoder.write(chunk));
  }
  scanWindow(overlap + decoder.end());
  if (options.expectedBytes !== undefined && bytesRead !== options.expectedBytes) {
    throw new Error("artifact entry size did not match its archive directory");
  }
}

async function scanZipEntries(filePath, matchedRuleIds) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 22) {
    throw new Error("invalid archive");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const directory = await readZipDirectory(handle, stat.size);
    let totalUncompressedBytes = 0;
    for (const entry of directory.entries) {
      totalUncompressedBytes += entry.uncompressedSize;
      if (
        entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES ||
        totalUncompressedBytes > MAX_ZIP_TOTAL_BYTES ||
        !Number.isSafeInteger(totalUncompressedBytes)
      ) {
        throw new Error("archive expanded size exceeded its scan bound");
      }
      if (entry.directory) {
        if (entry.compressedSize !== 0 || entry.uncompressedSize !== 0) {
          throw new Error("archive directory entry contained data");
        }
        continue;
      }
      const dataStart = await resolveZipEntryDataStart(handle, entry, directory.centralOffset);
      let compressed = Readable.from([]);
      if (entry.compressedSize > 0) {
        compressed = createReadStream(filePath, {
          start: dataStart,
          end: dataStart + entry.compressedSize - 1,
        });
      }
      const content = entry.compressionMethod === 8 ? compressed.pipe(createInflateRaw()) : compressed;
      await scanReadableForSecrets(content, matchedRuleIds, {
        expectedBytes: entry.uncompressedSize,
        maxBytes: MAX_ZIP_ENTRY_BYTES,
      });
    }
  } finally {
    await handle.close();
  }
}

async function readZipDirectory(handle, fileSize) {
  const tailSize = Math.min(fileSize, 22 + 0xffff);
  const tail = Buffer.alloc(tailSize);
  await readExact(handle, tail, fileSize - tailSize);
  let endOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
    if (
      tail.readUInt32LE(offset) === ZIP_END_SIGNATURE &&
      offset + 22 + tail.readUInt16LE(offset + 20) === tail.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error("archive end record was missing");

  const diskNumber = tail.readUInt16LE(endOffset + 4);
  const directoryDisk = tail.readUInt16LE(endOffset + 6);
  const entriesOnDisk = tail.readUInt16LE(endOffset + 8);
  const entryCount = tail.readUInt16LE(endOffset + 10);
  const directorySize = tail.readUInt32LE(endOffset + 12);
  const centralOffset = tail.readUInt32LE(endOffset + 16);
  const absoluteEndOffset = fileSize - tailSize + endOffset;
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    entryCount > MAX_ZIP_ENTRIES ||
    directorySize > MAX_ZIP_DIRECTORY_BYTES ||
    centralOffset + directorySize !== absoluteEndOffset
  ) {
    throw new Error("archive directory boundary was unsupported");
  }

  const central = Buffer.alloc(directorySize);
  await readExact(handle, central, centralOffset);
  const entries = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error("archive central entry was malformed");
    }
    const flags = central.readUInt16LE(cursor + 8);
    const compressionMethod = central.readUInt16LE(cursor + 10);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const diskStart = central.readUInt16LE(cursor + 34);
    const localOffset = central.readUInt32LE(cursor + 42);
    const entryLength = 46 + nameLength + extraLength + commentLength;
    if (
      cursor + entryLength > central.length ||
      flags & 0x1 ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff ||
      (compressionMethod !== 0 && compressionMethod !== 8) ||
      (compressionMethod === 0 && compressedSize !== uncompressedSize)
    ) {
      throw new Error("archive central entry used an unsupported feature");
    }
    const name = central.subarray(cursor + 46, cursor + 46 + nameLength);
    entries.push({
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localOffset,
      name,
      directory: name.length > 0 && name[name.length - 1] === 0x2f,
    });
    cursor += entryLength;
  }
  if (cursor !== central.length) throw new Error("archive central directory contained unparsed data");
  return { centralOffset, entries };
}

async function resolveZipEntryDataStart(handle, entry, centralOffset) {
  const localHeader = Buffer.alloc(30);
  await readExact(handle, localHeader, entry.localOffset);
  if (
    localHeader.readUInt32LE(0) !== ZIP_LOCAL_SIGNATURE ||
    localHeader.readUInt16LE(6) !== entry.flags ||
    localHeader.readUInt16LE(8) !== entry.compressionMethod
  ) {
    throw new Error("archive local entry did not match its directory");
  }
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const localName = Buffer.alloc(nameLength);
  await readExact(handle, localName, entry.localOffset + 30);
  if (!localName.equals(entry.name)) throw new Error("archive entry names did not match");
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  if (dataStart < 0 || dataStart + entry.compressedSize > centralOffset) {
    throw new Error("archive entry data crossed its directory boundary");
  }
  return dataStart;
}

async function readExact(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error("artifact ended before the declared archive boundary");
    offset += bytesRead;
  }
}

async function* walkFiles(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Never follow links out of the exact run root. A link is not scanned
      // evidence, so silently skipping it would turn the leakage gate green
      // without inspecting every entry.
      throw new Error("artifact redaction scan encountered an unsupported symbolic link");
    } else if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile()) {
      yield entryPath;
    } else {
      throw new Error("artifact redaction scan encountered an unsupported filesystem entry");
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootDir = process.argv[2] ? path.resolve(process.argv[2]) : await resolveDefaultScanRoot();
  try {
    await assertArtifactRedactionGate(rootDir);
    console.log("Verification artifact redaction passed.");
  } catch (error) {
    console.error(`Verification artifact redaction failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function resolveDefaultScanRoot() {
  const latestRunRoot = await readLatestRunArtifactRoot();
  return latestRunRoot ?? DEFAULT_ARTIFACT_ROOT;
}

async function readLatestRunArtifactRoot() {
  const pointer = await fs.readFile(LATEST_RUN_POINTER_PATH, "utf8").catch(() => undefined);
  if (!pointer) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(pointer);
    if (typeof parsed?.artifactRoot !== "string" || parsed.artifactRoot.trim().length === 0) {
      return undefined;
    }
    const artifactRoot = path.resolve(parsed.artifactRoot);
    const relative = path.relative(DEFAULT_ARTIFACT_ROOT, artifactRoot);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return artifactRoot;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
