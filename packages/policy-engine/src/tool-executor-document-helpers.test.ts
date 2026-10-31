import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolInvokeRequest, ToolPolicyConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { createPlainDocumentPdf } from "./document-pdf.js";
import { executeTool } from "./tool-executor.js";
import { DOCS_READ_BYTES_MAX } from "./tool-executor/document-helpers-executor.js";

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
    expect(result.truncated).toBe(false);
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

  it("caps docs.read_bytes", async () => {
    const root = createRoot();
    const file = path.join(root, "big.bin");
    fs.writeFileSync(file, Buffer.alloc(9 * 1024 * 1024, 1));
    const result = await executeTool(request("docs.read_bytes", { path: file }), createConfig(root), storage);
    expect(result.truncated).toBe(true);
    expect(result.sizeBytes).toBe(9 * 1024 * 1024);
    expect(Buffer.from(String(result.base64), "base64").length).toBe(DOCS_READ_BYTES_MAX);
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
