import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { createPlainDocumentPdf } from "./document-pdf.js";
import { executeTool } from "./tool-executor.js";
import {
  DOCS_DECOMPRESS_MAX_OUTPUT,
  DOCS_EXTRACT_TEXT_MAX_BYTES,
  DOCS_EXTRACT_TEXT_MAX_CHARS,
  DOCS_READ_BYTES_MAX,
} from "./tool-executor/document-helpers-executor.js";

const createdRoots: string[] = [];
const PHRASE = "Quarterly revenue grew twelve percent";
const storage = {} as AsyncStorage;

afterEach(() => {
  for (const root of createdRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-doc-helpers-"));
  createdRoots.push(root);
  return root;
}

function createConfig(root: string): ToolPolicyConfig {
  return {
    profiles: { danger: ["*"] },
    tools: { profile: "danger", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [root],
      readOnlyRoots: [root],
      networkAllowlist: [],
      riskyShellPatterns: [],
      requireApprovalForRiskyShell: true,
    },
  };
}

function request(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
  return { toolName, args, agentId: "agent-1", sessionId: "session-1" };
}

function writePdf(root: string): { file: string; bytes: Buffer } {
  const bytes = createPlainDocumentPdf("Report", [PHRASE]).buffer;
  const file = path.join(root, "report.pdf");
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}

describe("document helper tools", () => {
  it("extracts PDF text through docs.extract_text", async () => {
    const root = createRoot();
    const { file } = writePdf(root);
    const result = await executeTool(request("docs.extract_text", { path: file }), createConfig(root), storage);
    expect(result.format).toBe("pdf");
    expect(result.pageCount as number).toBeGreaterThanOrEqual(1);
    expect(String(result.text)).toContain(PHRASE);
    expect(result.offset).toBe(0);
    expect(result).not.toHaveProperty("nextOffset");
  });

  it("pages docs.extract_text by character offset", async () => {
    const root = createRoot();
    const file = path.join(root, "long.txt");
    const text = Array.from({ length: 150_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
    fs.writeFileSync(file, text);
    const config = createConfig(root);

    const first = await executeTool(request("docs.extract_text", { path: file }), config, storage);
    expect(DOCS_EXTRACT_TEXT_MAX_CHARS).toBe(60_000);
    expect(first.format).toBe("text");
    expect(first.totalChars).toBe(text.length);
    expect(String(first.text)).toHaveLength(DOCS_EXTRACT_TEXT_MAX_CHARS);
    expect(first.nextOffset).toBe(DOCS_EXTRACT_TEXT_MAX_CHARS);

    const pages = [String(first.text)];
    let next = first.nextOffset as number | undefined;
    while (next !== undefined) {
      const page = await executeTool(request("docs.extract_text", { path: file, offset: next }), config, storage);
      expect(page.offset).toBe(next);
      pages.push(String(page.text));
      next = page.nextOffset as number | undefined;
    }
    expect(pages).toHaveLength(3);
    expect(pages.join("")).toBe(text);

    const clamped = await executeTool(
      request("docs.extract_text", { path: file, maxChars: 1_000_000 }),
      config,
      storage,
    );
    expect(String(clamped.text)).toHaveLength(DOCS_EXTRACT_TEXT_MAX_CHARS);
  });

  it.each([
    ["CJK", "文書のテキスト"],
    ["emoji", "\u{1F600}\u{1F680}a"],
    ["JSON-escaped", '"\\'],
  ])(
    "keeps each docs.extract_text page of %s text inside the IPC byte bound",
    async (_label, unit) => {
      const root = createRoot();
      const file = path.join(root, "wide.txt");
      fs.writeFileSync(file, unit.repeat(Math.ceil(120_000 / unit.length)));
      const config = createConfig(root);

      const pages: string[] = [];
      let total = 0;
      let next: number | undefined = 0;
      while (next !== undefined) {
        const page = await executeTool(request("docs.extract_text", { path: file, offset: next }), config, storage);
        const pageText = String(page.text);
        total = Number(page.totalChars);
        expect(pageText.length).toBeGreaterThan(0);
        expect(Buffer.byteLength(JSON.stringify(pageText), "utf8")).toBeLessThanOrEqual(
          DOCS_EXTRACT_TEXT_MAX_BYTES + 2,
        );
        expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(128 * 1024);
        const last = pageText.charCodeAt(pageText.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        pages.push(pageText);
        next = page.nextOffset as number | undefined;
      }
      expect(pages.length).toBeGreaterThan(1);
      expect(pages[0]!.length).toBeLessThan(DOCS_EXTRACT_TEXT_MAX_CHARS);
      expect(pages.join("")).toHaveLength(total);
    },
    30_000,
  );

  it("advances every docs.extract_text page by a whole character when maxChars is 1", async () => {
    const root = createRoot();
    const file = path.join(root, "emoji.txt");
    const text = "\u{1F600}a\u{1F680}";
    fs.writeFileSync(file, text);
    const config = createConfig(root);

    const pages: string[] = [];
    let next: number | undefined = 0;
    while (next !== undefined && pages.length < text.length) {
      const page = await executeTool(
        request("docs.extract_text", { path: file, offset: next, maxChars: 1 }),
        config,
        storage,
      );
      if (page.nextOffset !== undefined) {
        expect(page.nextOffset).toBeGreaterThan(next);
      }
      pages.push(String(page.text));
      next = page.nextOffset as number | undefined;
    }
    expect(next).toBeUndefined();
    expect(pages).toEqual(["\u{1F600}", "a", "\u{1F680}"]);
  });

  it("rejects a path outside read roots", async () => {
    const root = createRoot();
    const outside = createRoot();
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    await expect(
      executeTool(
        request("docs.extract_text", { path: path.join(outside, "secret.txt") }),
        createConfig(root),
        storage,
      ),
    ).rejects.toThrow(/read|allowed|outside/i);
  });

  it("requires exactly one of path or attachmentId", async () => {
    const root = createRoot();
    const { file } = writePdf(root);
    const config = createConfig(root);
    await expect(
      executeTool(request("docs.read_bytes", { path: file, attachmentId: "att_1" }), config, storage),
    ).rejects.toThrow(/exactly one of path or attachmentId/);
    await expect(executeTool(request("docs.read_bytes", {}), config, storage)).rejects.toThrow(
      /exactly one of path or attachmentId/,
    );
  });

  it("caps docs.read_bytes at 64 KiB per call", async () => {
    const root = createRoot();
    const file = path.join(root, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 1));
    const result = await executeTool(
      request("docs.read_bytes", { path: file, length: 8 * 1024 * 1024 }),
      createConfig(root),
      storage,
    );
    expect(DOCS_READ_BYTES_MAX).toBe(65_536);
    expect(result.sizeBytes).toBe(9 * 1024 * 1024);
    expect(Buffer.from(String(result.base64), "base64").length).toBe(DOCS_READ_BYTES_MAX);
    expect(result.nextOffset).toBe(DOCS_READ_BYTES_MAX);
  });

  it("pages docs.read_bytes with offset and length", async () => {
    const root = createRoot();
    const file = path.join(root, "data.bin");
    const bytes = Buffer.from(Array.from({ length: 150_000 }, (_, index) => index % 251));
    fs.writeFileSync(file, bytes);
    const config = createConfig(root);

    const chunks: Buffer[] = [];
    let next: number | undefined = 0;
    while (next !== undefined) {
      const page = await executeTool(request("docs.read_bytes", { path: file, offset: next }), config, storage);
      expect(page.offset).toBe(next);
      chunks.push(Buffer.from(String(page.base64), "base64"));
      next = page.nextOffset as number | undefined;
    }
    expect(chunks.map((chunk) => chunk.length)).toEqual([65_536, 65_536, 150_000 - 2 * 65_536]);
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);

    const window = await executeTool(
      request("docs.read_bytes", { path: file, offset: 100, length: 10 }),
      config,
      storage,
    );
    expect(Buffer.from(String(window.base64), "base64").equals(bytes.subarray(100, 110))).toBe(true);
    expect(window.nextOffset).toBe(110);

    const past = await executeTool(request("docs.read_bytes", { path: file, offset: 999_999 }), config, storage);
    expect(past.base64).toBe("");
    expect(past).not.toHaveProperty("nextOffset");
  });

  it("reads only the requested window of an attachment", async () => {
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 7));
    // A ranged hook returns just the window and the full size, as the gateway's positioned read does.
    const readAttachmentBytes = vi.fn(
      async (_request: ToolInvokeRequest, _attachmentId: string, window: { start: number; maxBytes: number }) => ({
        fileName: "a.bin",
        mimeType: "application/octet-stream",
        bytes: bytes.subarray(window.start, window.start + window.maxBytes),
        totalBytes: bytes.length,
      }),
    );
    const config = createConfig(createRoot());
    const page = await executeTool(
      request("docs.read_bytes", { attachmentId: "att_1", offset: 65_536 }),
      config,
      storage,
      { readAttachmentBytes },
    );
    expect(readAttachmentBytes.mock.calls[0]?.[2]).toEqual({ start: 65_536, maxBytes: 65_536 });
    expect(Buffer.from(String(page.base64), "base64").equals(bytes.subarray(65_536))).toBe(true);
    expect(page).toMatchObject({ sizeBytes: 70_000, offset: 65_536 });
    expect(page).not.toHaveProperty("nextOffset");

    await executeTool(request("docs.extract_text", { attachmentId: "att_1" }), config, storage, {
      readAttachmentBytes,
    }).catch(() => undefined);
    // Text extraction asks for the whole file up to its memory guard, so the size check runs before the read.
    expect(readAttachmentBytes.mock.calls[1]?.[2]).toEqual({ start: 0, maxBytes: 64 * 1024 * 1024 });
  });

  it("pages an attachment through docs.read_bytes", async () => {
    const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 7));
    const readAttachmentBytes = vi.fn(async () => ({ fileName: "a.bin", mimeType: "application/octet-stream", bytes }));
    const config = createConfig(createRoot());
    const first = await executeTool(request("docs.read_bytes", { attachmentId: "att_1" }), config, storage, {
      readAttachmentBytes,
    });
    expect(first.nextOffset).toBe(65_536);
    const second = await executeTool(
      request("docs.read_bytes", { attachmentId: "att_1", offset: first.nextOffset }),
      config,
      storage,
      { readAttachmentBytes },
    );
    expect(second).not.toHaveProperty("nextOffset");
    const joined = Buffer.concat([
      Buffer.from(String(first.base64), "base64"),
      Buffer.from(String(second.base64), "base64"),
    ]);
    expect(joined.equals(bytes)).toBe(true);
  });

  it("stops a decompression bomb", async () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
    await expect(
      executeTool(
        request("docs.decompress", { base64: bomb.toString("base64"), format: "gzip", maxOutputBytes: 1024 }),
        createConfig(createRoot()),
        storage,
      ),
    ).rejects.toThrow(/exceeds 1024 bytes/);
  });

  it("caps docs.decompress output at 64 KiB by default", async () => {
    expect(DOCS_DECOMPRESS_MAX_OUTPUT).toBe(65_536);
    const config = createConfig(createRoot());
    const over = gzipSync(Buffer.alloc(65_537)).toString("base64");
    await expect(
      executeTool(request("docs.decompress", { base64: over, format: "gzip" }), config, storage),
    ).rejects.toThrow(/exceeds 65536 bytes/);
    await expect(
      executeTool(
        request("docs.decompress", { base64: over, format: "gzip", maxOutputBytes: 1_000_000 }),
        config,
        storage,
      ),
    ).rejects.toThrow(/exceeds 65536 bytes/);
    const exact = await executeTool(
      request("docs.decompress", { base64: gzipSync(Buffer.alloc(65_536)).toString("base64"), format: "gzip" }),
      config,
      storage,
    );
    expect(exact.outputBytes).toBe(65_536);
  });

  it("decompresses within the cap", async () => {
    const result = await executeTool(
      request("docs.decompress", { base64: gzipSync(Buffer.from("hello")).toString("base64"), format: "gzip" }),
      createConfig(createRoot()),
      storage,
    );
    expect(Buffer.from(String(result.base64), "base64").toString()).toBe("hello");
    expect(result.outputBytes).toBe(5);
  });

  it("reads an attachment through the gateway hook", async () => {
    const root = createRoot();
    const { bytes } = writePdf(root);
    const readAttachmentBytes = vi.fn(async (_request: ToolInvokeRequest, _attachmentId: string) => ({
      fileName: "a.pdf",
      mimeType: "application/pdf",
      bytes,
    }));
    const result = await executeTool(
      request("docs.extract_text", { attachmentId: "att_1" }),
      createConfig(root),
      storage,
      { readAttachmentBytes },
    );
    expect(String(result.text)).toContain(PHRASE);
    expect(readAttachmentBytes).toHaveBeenCalledTimes(1);
    expect(readAttachmentBytes.mock.calls[0]?.[1]).toBe("att_1");
  });

  it("refuses attachments when no hook is wired", async () => {
    await expect(
      executeTool(request("docs.read_bytes", { attachmentId: "att_1" }), createConfig(createRoot()), storage),
    ).rejects.toThrow("Attachments are not readable here.");
  });

  it("fs.read flags binary files", async () => {
    const root = createRoot();
    const { file } = writePdf(root);
    fs.appendFileSync(file, Buffer.from([0, 1, 2]));
    const result = await executeTool(request("fs.read", { path: file }), createConfig(root), storage);
    expect(result.binary).toBe(true);
    expect(result.content).toBe("");
  });
});
