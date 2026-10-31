import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import { clampInt } from "@goatcitadel/contracts";
import { parseNativeFileDocument } from "../native-document-parser.js";

export const DOCS_READ_BYTES_MAX = 8 * 1024 * 1024;
export const DOCS_EXTRACT_TEXT_MAX_CHARS = 200_000;
export const DOCS_DECOMPRESS_MAX_OUTPUT = 16 * 1024 * 1024;
/** Memory guard for text extraction, which needs the whole file to parse it. */
const DOCS_EXTRACT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

const DOCUMENT_HELPER_TOOL_NAMES = new Set(["docs.read_bytes", "docs.extract_text", "docs.decompress"]);

export interface DocumentHelperAttachmentBytes {
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

export interface DocumentHelperExecutorDeps {
  assertReadPathAllowedForRequest: (
    targetPath: string,
    request: ToolInvokeRequest,
    config: ToolPolicyConfig,
    storage: AsyncStorage,
  ) => Promise<void>;
  readAttachmentBytes?: (request: ToolInvokeRequest, attachmentId: string) => Promise<DocumentHelperAttachmentBytes>;
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
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return {
        name: path.basename(full),
        bytes: buffer.subarray(0, offset),
        cut: stat.size > maxBytes,
        totalBytes: stat.size,
      };
    } finally {
      await handle.close();
    }
  }
  if (!deps.readAttachmentBytes) {
    throw new Error("Attachments are not readable here.");
  }
  const loaded = await deps.readAttachmentBytes(request, attachmentId as string);
  return {
    name: loaded.fileName,
    bytes: loaded.bytes.length > maxBytes ? loaded.bytes.subarray(0, maxBytes) : loaded.bytes,
    cut: loaded.bytes.length > maxBytes,
    totalBytes: loaded.bytes.length,
  };
}

async function readBytes(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: DocumentHelperExecutorDeps,
) {
  const maxBytes = clampInt(request.args.maxBytes, DOCS_READ_BYTES_MAX, 1, DOCS_READ_BYTES_MAX);
  const source = await resolveSource(request, config, storage, deps, maxBytes);
  return {
    name: source.name,
    sizeBytes: source.totalBytes,
    sha256: createHash("sha256").update(source.bytes).digest("hex"),
    base64: source.bytes.toString("base64"),
    truncated: source.cut,
  };
}

async function extractText(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  deps: DocumentHelperExecutorDeps,
) {
  const maxChars = clampInt(request.args.maxChars, DOCS_EXTRACT_TEXT_MAX_CHARS, 1, DOCS_EXTRACT_TEXT_MAX_CHARS);
  const source = await resolveSource(request, config, storage, deps, DOCS_EXTRACT_SOURCE_MAX_BYTES);
  if (source.cut) {
    throw new Error(`${source.name} is too large to extract text from.`);
  }
  const parsed = await parseNativeFileDocument(source.name, source.bytes);
  const text = parsed.normalizedText;
  const format = parsed.parser.format === "pdf" || parsed.parser.format === "docx" ? parsed.parser.format : "text";
  return {
    name: source.name,
    format,
    ...(parsed.parser.pageCount === undefined ? {} : { pageCount: parsed.parser.pageCount }),
    text: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
  };
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
