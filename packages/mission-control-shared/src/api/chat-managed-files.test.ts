import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { downloadChatManagedFile, fetchChatManagedFiles } from "./chat-managed-files.js";
import { request } from "./client-core.js";

vi.mock("./client-core.js", () => ({
  buildGatewayUrl: (path: string, base: string) => base + path,
  getGatewayApiBaseUrl: () => "http://127.0.0.1",
  readGatewayAuthHeaders: () => ({ Authorization: "Bearer fixture-operator" }),
  request: vi.fn(),
}));

const bytes = Uint8Array.of(0, 13, 10, 255);
const file = {
  workspaceId: "workspace",
  projectId: "project",
  path: "notes/my file.txt",
  revisionId: "revision",
  previousRevisionId: null,
  contentSha256: createHash("sha256").update(bytes).digest("hex"),
  byteLength: bytes.length,
  deleted: false,
  canRestore: false,
};

afterEach(() => vi.unstubAllGlobals());

it("encodes a folder filter as one scoped query argument", async () => {
  vi.mocked(request).mockResolvedValueOnce({ items: [file] });
  await expect(fetchChatManagedFiles("session", { prefix: "notes & drafts/brief.txt" })).resolves.toEqual({
    items: [file],
  });
  expect(request).toHaveBeenCalledWith(
    "/api/v1/chat/sessions/session/managed-files?prefix=notes+%26+drafts%2Fbrief.txt",
    expect.objectContaining({ cache: "no-store" }),
  );
});

it("downloads the requested revision's exact bytes with operator authorization", async () => {
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { "Content-Type": "application/octet-stream" } }));
  vi.stubGlobal("fetch", fetcher);
  const blob = await downloadChatManagedFile("session", file, new AbortController().signal);
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  expect(fetcher).toHaveBeenCalledWith(
    "http://127.0.0.1/api/v1/chat/sessions/session/managed-files/download?path=notes%2Fmy+file.txt&revisionId=revision",
    expect.objectContaining({ headers: { Authorization: "Bearer fixture-operator" } }),
  );
});

it.each([Uint8Array.of(0), new Uint8Array(5), new Uint8Array(4)])(
  "withholds a download whose size or digest does not match the listed revision",
  async (body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { headers: { "Content-Type": "application/octet-stream" } })),
    );
    await expect(downloadChatManagedFile("session", file, new AbortController().signal)).rejects.toThrow("verified");
  },
);
