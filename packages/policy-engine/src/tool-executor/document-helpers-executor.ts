import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import { parseNativeFileDocument } from "../native-document-parser.js";

// Each result must fit the 128 KB Code Mode IPC message bound, so the helpers page instead of returning large
// payloads: 64 KiB of raw bytes is about 87 KB of base64.
export const DOCS_READ_BYTES_MAX = 65_536;
export const DOCS_EXTRACT_TEXT_MAX_CHARS = 60_000;
/**
 * Byte budget for one extract_text page, counted as JSON-encoded UTF-8. 60 000 characters of CJK, emoji or
 * escape-heavy text can pass the IPC bound, so a page also stops here and the guest pages on with nextOffset.
 */
export const DOCS_EXTRACT_TEXT_MAX_BYTES = 96 * 1024;
export const DOCS_DECOMPRESS_MAX_OUTPUT = 65_536;
/** Memory guard for text extraction, which needs the whole file to parse it. */
const DOCS_EXTRACT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

const DOCUMENT_HELPER_TOOL_NAMES = new Set(["docs.read_bytes", "docs.extract_text", "docs.decompress"]);

export interface DocumentHelperAttachmentBytes {
  fileName: string;
  mimeType: string;
  /** The requested window, or the whole attachment when `totalBytes` is unset. */
  bytes: Buffer;
  /** The attachment's full size; set when `bytes` holds only the requested window. */
  totalBytes?: number;
}

/** The byte window a helper call needs: up to `maxBytes` from `start`. */
export interface DocumentHelperAttachmentWindow {
  start: number;
  maxBytes: number;
}

export interface DocumentHelperExecutorDeps {
  assertReadPathAllowedForRequest: (
    targetPath: string,
    request: ToolInvokeRequest,
    config: ToolPolicyConfig,
    storage: AsyncStorage,
  ) => Promise<void>;
  readAttachmentBytes?: (
    request: ToolInvokeRequest,
    attachmentId: string,
    window: DocumentHelperAttachmentWindow,
  ) => Promise<DocumentHelperAttachmentBytes>;
}

export function isDocumentHelperToolName(toolName: string): boolean {
  return DOCUMENT_HELPER_TOOL_NAMES.has(toolName);
}

export async function executeDocumentHelperTool(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: DocumentHelperExecutorDeps,
): Promise<Record<string, unknown>> {
  switch (request.toolName) {
    case "docs.read_bytes":
      return readBytes(request, config, storage, deps);
    case "docs.extract_text":
      return extractText(request, config, storage, deps);
    case "docs.decompress":
      return decompress(request);
    default:
      throw new Error(`Unsupported document helper tool: ${request.toolName}`);
  }
}

interface ResolvedSource {
  name: string;
  bytes: Buffer;
  /** True when the source held more than the byte cap and `bytes` was cut short. */
  cut: boolean;
  totalBytes: number;
}

async function resolveSource(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: DocumentHelperExecutorDeps,
  maxBytes: number,
  startByte = 0,
): Promise<ResolvedSource> {
  const rawPath = request.args.path;
  const rawAttachmentId = request.args.attachmentId;
  const pathArg = typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath : undefined;
  const attachmentId =
    typeof rawAttachmentId === "string" && rawAttachmentId.trim().length > 0 ? rawAttachmentId.trim() : undefined;
  if ((pathArg === undefined) === (attachmentId === undefined)) {
    throw new Error("Provide exactly one of path or attachmentId.");
  }
  if (pathArg !== undefined) {
    await deps.assertReadPathAllowedForRequest(pathArg, request, config, storage);
    const full = path.resolve(pathArg);
    const handle = await fs.open(full, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${full}`);
      }
      const start = Math.min(startByte, stat.size);
      const length = Math.min(stat.size - start, maxBytes);
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return {
        name: path.basename(full),
        bytes: buffer.subarray(0, offset),
        cut: stat.size - start > maxBytes,
        totalBytes: stat.size,
      };
    } finally {
      await handle.close();
    }
  }
  if (!deps.readAttachmentBytes) {
    throw new Error("Attachments are not readable here.");
  }
  // Ask for just the window, so a ranged hook reads one page instead of the whole attachment per call.
  const loaded = await deps.readAttachmentBytes(request, attachmentId as string, { start: startByte, maxBytes });
  const totalBytes = loaded.totalBytes ?? loaded.bytes.length;
  const start = Math.min(startByte, totalBytes);
  return {
    name: loaded.fileName,
    bytes:
      loaded.totalBytes === undefined
        ? loaded.bytes.subarray(start, start + maxBytes)
        : loaded.bytes.subarray(0, maxBytes),
    cut: totalBytes - start > maxBytes,
    totalBytes,
  };
}

async function readBytes(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: DocumentHelperExecutorDeps,
) {
  const offset = clampInt(request.args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const length = clampInt(request.args.length, DOCS_READ_BYTES_MAX, 1, DOCS_READ_BYTES_MAX);
  const source = await resolveSource(request, config, storage, deps, length, offset);
  const start = Math.min(offset, source.totalBytes);
  return {
    name: source.name,
    sizeBytes: source.totalBytes,
    offset: start,
    /** sha256 of the bytes in this page. */
    sha256: createHash("sha256").update(source.bytes).digest("hex"),
    base64: source.bytes.toString("base64"),
    ...(source.cut ? { nextOffset: start + source.bytes.length } : {}),
  };
}

async function extractText(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: DocumentHelperExecutorDeps,
) {
  const offset = clampInt(request.args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maxChars = clampInt(request.args.maxChars, DOCS_EXTRACT_TEXT_MAX_CHARS, 1, DOCS_EXTRACT_TEXT_MAX_CHARS);
  const source = await resolveSource(request, config, storage, deps, DOCS_EXTRACT_SOURCE_MAX_BYTES);
  if (source.cut) {
    throw new Error(`${source.name} is too large to extract text from.`);
  }
  const parsed = await parseNativeFileDocument(source.name, source.bytes);
  const text = parsed.normalizedText;
  const end = pageEnd(text, offset, maxChars, DOCS_EXTRACT_TEXT_MAX_BYTES);
  const format = parsed.parser.format === "pdf" || parsed.parser.format === "docx" ? parsed.parser.format : "text";
  return {
    name: source.name,
    format,
    ...(parsed.parser.pageCount === undefined ? {} : { pageCount: parsed.parser.pageCount }),
    totalChars: text.length,
    offset: Math.min(offset, text.length),
    text: text.slice(offset, end),
    ...(end < text.length ? { nextOffset: end } : {}),
  };
}

const JSON_SHORT_ESCAPES = new Set([0x22, 0x5c, 0x08, 0x09, 0x0a, 0x0c, 0x0d]);

/** UTF-16 code units consumed at index and the UTF-8 bytes they cost inside a JSON string, escapes included. */
function jsonByteCost(text: string, index: number): { units: number; bytes: number } {
  const code = text.charCodeAt(index);
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      return { units: 2, bytes: 4 };
    }
  }
  if (JSON_SHORT_ESCAPES.has(code)) {
    return { units: 1, bytes: 2 };
  }
  if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
    return { units: 1, bytes: 6 };
  }
  if (code < 0x80) {
    return { units: 1, bytes: 1 };
  }
  return { units: 1, bytes: code < 0x800 ? 2 : 3 };
}

/**
 * Page end from offset: up to maxChars code units and maxBytes JSON-encoded bytes, never splitting a surrogate pair.
 * A page always takes at least one whole character, so the only page longer than maxChars is a single surrogate pair
 * when maxChars is 1; pagination always advances.
 */
function pageEnd(text: string, offset: number, maxChars: number, maxBytes: number): number {
  const start = Math.min(offset, text.length);
  const limit = Math.min(text.length, offset + maxChars);
  let index = start;
  let bytes = 0;
  while (index < limit) {
    const cost = jsonByteCost(text, index);
    if (index > start && (index + cost.units > limit || bytes + cost.bytes > maxBytes)) {
      break;
    }
    bytes += cost.bytes;
    index += cost.units;
  }
  return index;
}

function decompress(request: ToolInvokeRequest) {
  const { base64, format } = request.args;
  if (typeof base64 !== "string" || base64.length === 0) {
    throw new Error("base64 is required.");
  }
  const maxOutputLength = clampInt(
    request.args.maxOutputBytes,
    DOCS_DECOMPRESS_MAX_OUTPUT,
    1,
    DOCS_DECOMPRESS_MAX_OUTPUT,
  );
  const input = Buffer.from(base64, "base64");
  const options = { maxOutputLength };
  let output: Buffer;
  try {
    switch (format) {
      case "gzip":
        output = gunzipSync(input, options);
        break;
      case "deflate":
        output = inflateSync(input, options);
        break;
      case "raw-deflate":
        output = inflateRawSync(input, options);
        break;
      case "brotli":
        output = brotliDecompressSync(input, options);
        break;
      default:
        throw new Error('format must be one of "gzip", "deflate", "raw-deflate" or "brotli".');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`Decompressed output exceeds ${maxOutputLength} bytes.`, { cause: error });
    }
    throw error;
  }
  return { base64: output.toString("base64"), outputBytes: output.length };
}
