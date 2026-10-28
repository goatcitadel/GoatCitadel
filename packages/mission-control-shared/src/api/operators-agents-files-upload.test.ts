// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFile } from "./operators-agents-files-operations";

const receipt = { relativePath: "notes/a.md", fullPath: "notes/a.md", bytes: 5 };
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFile", () => {
  it("streams the text as raw bytes with the path in the query and a SHA-256 the Gateway can check", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(uploadFile("notes/a.md", "hello", { expectAbsent: true })).resolves.toEqual(receipt);

    const [url, init] = fetchMock.mock.calls[0]!;
    const sent = new URL(String(url));
    expect(sent.pathname).toBe("/api/v1/files/upload");
    expect(Object.fromEntries(sent.searchParams)).toEqual({ relativePath: "notes/a.md", expectAbsent: "true" });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/octet-stream");
    expect(headers.get("idempotency-key")).toBeTruthy();
    expect(headers.get("x-content-sha256")).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(init?.body).toBeInstanceOf(Blob);
    await expect((init?.body as Blob).text()).resolves.toBe("hello");
  });

  it("skips the hash for a file too large to hash in memory", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(receipt), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const large = new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]);

    await uploadFile("notes/big.md", large);

    const headers = new Headers(fetchMock.mock.calls[0]![1]?.headers);
    expect(headers.get("x-content-sha256")).toBeNull();
    expect(new URL(String(fetchMock.mock.calls[0]![0])).searchParams.has("expectAbsent")).toBe(false);
  });
});
