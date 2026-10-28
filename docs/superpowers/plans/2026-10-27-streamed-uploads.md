# Streamed Uploads Plan

> **Status:** PR 1 (workspace files) is merged as #619; #622 then brought `files-route-service.ts` back under its architecture-metrics cap. PR 2 (chat attachments) is built.
>
> **Operator rulings (2026-10-27/28):** D1 text-only; D2 keep JSON up to 1 MiB; D3 metadata in the query string; a streamed upload's idempotency stays one key per attempt, with no content binding beyond the optional `X-Content-SHA256`.
>
> **Where PR 2 differs from this plan:**
> - The composer still starts every picked file's upload at once. Streaming already keeps the Gateway's memory per upload flat and removes the browser's base64 copies, and any edit to `useChatComposerInteractions.ts` would reformat 56 lines of it that are not prettier-clean.
> - The service takes `{ bytesBase64 } | { bytes } | { stream }` rather than a `source` object, so existing callers and tests keep their shape.
>
> **Where PR 1 differs from this plan:**
> - Stale staging files are swept at the start of each upload, not at Gateway start, so no startup wiring is needed.
> - `coverage-exercise.ts` keeps its small JSON upload, which still covers the retained JSON path.
> - The auth plugin refuses a companion-signed streamed upload with 401. The device-key signature covers a parsed JSON body, and a companion's signed mutation path may not carry a query string.

**Goal:** Large uploads stop being held in Gateway memory several times over. Workspace file uploads (up to 50 MB) and chat attachments (up to 20 MB) stream to disk, so the Gateway's memory use stays flat whatever the file size.

**Source:** finding #6 of the external code review: "50 MB uploads buffered as a JSON string".

**Architecture:** both routes keep their URLs and receipts. A second request shape, `Content-Type: application/octet-stream`, carries the raw bytes; the metadata goes in the query string. The existing JSON shape stays for small bodies. Two PRs, one per route, each with its own server and client changes.

**Tech Stack:** Fastify (Gateway), Node streams and `fs/promises`, `@goatcitadel/mission-control-shared` API client, `threaded-surface-core` composer hooks, Vitest.

## What the review got right, and what it got wrong

The finding says the uploads are base64 JSON. That is half right:

| Route | What the body is | Size limit | Callers |
|---|---|---|---|
| `POST /api/v1/files/upload` | `{ relativePath, content, expectAbsent? }`. `content` is **plain text**, not base64. The Gateway writes it as UTF-8 (`files-route-service.ts`, `uploadWorkspaceFile`). | 50 MB of content; body limit about 52.5 MB (`routes/files.ts`, `MAX_UPLOAD_BODY_BYTES`) | Library "Upload text file" (`LibraryFileUpload.tsx`), Classic `LibraryFilesSection.tsx`, TUI files menu (`tui/main.ts`), `coverage-exercise.ts` |
| `POST /api/v1/chat/attachments` | `{ sessionId, projectId?, fileName, mimeType, bytesBase64 }`. **This one is base64.** | 20 MB decoded; body limit about 26.7 MB (`routes/chat.attachments.ts`) | Chat composer file picker and drag-drop (`useChatComposerInteractions.ts`, several files at once via `Promise.all`), "attach workspace file" palette action (`useChatComposerPaletteActions.ts`), testbench. Inside the Gateway, artifact renders call the service directly with base64 they just made (`html-artifact-render-service.ts`) |

Every caller of the files route uploads typed or pasted text. No caller sends binary data there.

Other base64 routes (`/api/v1/voice/*`, `/api/v1/llm/*`, `/api/v1/comms/*`) have no route body limit, so Fastify's 1 MiB default applies. They are out of scope.

## Where the memory goes today

These are estimates from reading the code, not measurements. V8 stores a string at 1 byte per character when it is Latin-1 and 2 bytes otherwise, so text uploads can double.

**Workspace file, 50 MB of text, in the Gateway:**
1. The JSON parser reads the whole body as one string (`empty-json-body-parser.ts`, `parseAs: "string"`): about 50 MB, or up to 100 MB.
2. `JSON.parse` makes a second `content` string of the same size.
3. The idempotency plugin fingerprints the body before the route runs (`plugins/idempotency.ts`, `hashMutationPayload`, then `stableStringify`), which serializes `content` a third time.
4. `fs.writeFile(..., "utf8")` encodes a fourth copy, 50 MB, as a Buffer.

The peak is roughly 200 MB, or up to about 350 MB, per upload. The browser also holds the text-box string plus its `JSON.stringify` copy.

**Chat attachment, 20 MB file:**
- In the Gateway: the body string (about 27 MB), the parsed string (27 MB), the idempotency serialization (27 MB), `decodeStrictBase64`'s whitespace-stripped copy (27 MB), the decoded Buffer (20 MB) and its re-encode round-trip check (27 MB). That's about 150 MB per file.
- The composer uploads every picked file at once, so five files means about 750 MB.
- In the browser: the `readAsDataURL` string (27 MB) plus the `JSON.stringify` copy (27 MB), for each file.

Nothing caps how many uploads run at the same time.

## Proposed design

### Request shape (both routes)

- `Content-Type: application/octet-stream`. The body is the file's bytes, exactly. In the browser it is the `File` or `Blob` itself, so `fetch` streams it from disk without loading it into the JS heap.
- **Metadata goes in the query string:**
  - files: `relativePath`, `expectAbsent`;
  - attachments: `sessionId`, `projectId`, `fileName`, `mimeType`.

  None of these are secrets. Gateway request logging is off unless verbose. See D3.
- `Content-Length` is required (411 without it). A value over the limit gets 413 before any byte is read. A body that runs past its declared length is cut off with 413 too.
- An optional `X-Content-SHA256` header (hex). When present, the Gateway compares it with the hash it computed while streaming, and rejects a mismatch with 400.
- **The JSON shape stays** for small bodies, under Fastify's default 1 MiB limit. Pasted notes keep working through older clients. See D2.

### Gateway: a shared streaming helper

`apps/gateway/src/services/streamed-upload.ts`, new, used by both routes:
- Registers an `application/octet-stream` content-type parser **inside each route's own plugin scope**. It hands the raw request stream to the handler, `done(null, payload)`, without buffering.
- `receiveUpload(stream, { maxBytes, declaredLength, stagingDir, onChunk })`:
  - pipes the request through a byte-counting transform into a staging file;
  - hashes with SHA-256 as the bytes stream;
  - removes the staging file on any error, client abort or limit breach (`stream/promises.pipeline`, plus a `finally` unlink).
  - It returns `{ stagingPath, bytes, sha256, head }`, where `head` is the first 16 KB for sniffing and previews.
- The staging dir is a Gateway-owned folder inside the write jail, on the same volume as the target, so the final move is a rename and not a copy: for example `<workspace>/.goatcitadel-uploads/`. Add it to `DEFAULT_WORKSPACE_FILE_LIST_IGNORES` so uploads in progress never show in listings.
- **Idempotency:** add a `streamed_upload_v1` case to `hashMutationPayload`. It fingerprints `{ kind, path, canonical query, content-length, x-content-sha256 }` and never the body. That matches the existing vault and credential routes, where "a key identifies one attempt". Because the parser returns the stream right away, the claim still happens in `preHandler`, before any byte is read.

### Route 1: workspace files

- **Same checks as today:** `normalizeRelativePath`, `assertWritePathInJail`, the 50 MB limit, and the receipt `{ relativePath, fullPath, bytes }` with the `file_uploaded` realtime event.
- **Text only, as today** (unless D1 says otherwise): a `TextDecoder("utf-8", { fatal: true })` checks each chunk as it streams, and invalid UTF-8 gets 400.
- **`expectAbsent` keeps its atomic guarantee:** `fs.link(staging, target)` fails with `EEXIST` if a file appeared since the review, which gives the same 409 `ALREADY_EXISTS` as today's `"wx"`. The staging file is unlinked afterwards. Without `expectAbsent`, `fs.rename(staging, target)` replaces the file. On Windows, Node's rename uses `MoveFileEx` with replace-existing, so this works there too.

### Route 2: chat attachments

- **Same checks as today:** session lookup, workspace match, `sanitizeAttachmentFileName`, the 20 MB limit, the receipt and the `chat_attachment_uploaded` event.
- `assertAttachmentBytesMatchMimeHint` runs on `head`. `sniffAttachmentBytes` only reads magic bytes, so this needs no change.
- `extractAttachmentPreview` already uses only the first 4,000 characters, so it runs on `head`.
- `sha256` and `sizeBytes` come from the streaming helper. The staging file is renamed to its `attachments/YYYY/MM/<id>-<name>` path.
- **Refactor the service** to take `{ source: { kind: "staged", path, bytes, sha256, head } | { kind: "buffer", bytes } }`, not `bytesBase64`. The JSON route decodes base64 into `kind: "buffer"`. Artifact renders pass the PNG Buffer directly, so their base64 round-trip goes away.

### Clients

- `mission-control-shared`:
  - `uploadFile(relativePath, content: string | Blob, options)` sends `octet-stream`; a string is wrapped in a `Blob` first.
  - `uploadChatAttachment({ file })` sends the `File` as the body, and `encodeFileBase64` is deleted.
  - Add `X-Content-SHA256` only when the hash is cheap: skip it for files over 8 MB, because `crypto.subtle` cannot hash a stream.
- **Composer:** upload at most 2 files at a time instead of `Promise.all` over all of them. The client caps how many uploads run at once; the server cap is optional below.
- **TUI** (`tui/api-client.ts`) and `coverage-exercise.ts`: move to `octet-stream`.
- **Testbench catalog:** no change. It already calls the shared client.

### Optional: limit uploads in flight on the Gateway

A small per-process limit, such as 4 streamed uploads at once, answering 429 with `Retry-After`. The Gateway is local-first and has one operator, so this is cheap insurance, not a requirement. Leave it out unless the operator wants it.

## PRs

### PR 1: workspace files stream (server, clients, tests)

- [ ] `streamed-upload.ts` helper and its tests: limit breach, client abort, missing or oversized `Content-Length`, hash mismatch, staging cleanup.
- [ ] `routes/files.ts`: the `octet-stream` branch in its own scope, keeping the JSON branch for bodies up to 1 MiB.
- [ ] `files-route-service.ts`: `uploadWorkspaceFileFromStaging`, with the link or rename move and the UTF-8 check.
- [ ] `plugins/idempotency.ts`: the `streamed_upload_v1` fingerprint, plus a test that the body is never serialized.
- [ ] The staging dir in the listing ignores, and a test that paged listings skip it.
- [ ] Shared `uploadFile`, TUI and `coverage-exercise` use the stream.
- [ ] **Proof:** a 50 MB upload through `app.inject` with `process.memoryUsage().heapUsed` sampled, which stays well under the file size. Expected in the race test: an `expectAbsent` upload, with a file created between staging and the move, gets 409.
- [ ] **Lanes:** focused files and idempotency tests, `pnpm --filter @goatcitadel/gateway typecheck`, `pnpm verify:auth:matrix` (auth posture on the new content type), `git diff --check`.

### PR 2: chat attachments stream (server, clients, tests)

- [ ] `chat-attachment-service.ts` takes a staged or buffer source; `html-artifact-render-service.ts` passes the Buffer.
- [ ] `routes/chat.attachments.ts`: the `octet-stream` branch, keeping the JSON branch for bodies up to 1 MiB.
- [ ] Shared `uploadChatAttachment` sends the `File`; delete `encodeFileBase64`; the composer uploads 2 at a time.
- [ ] **Proof:** the MIME-mismatch rejection still holds for the stream (a PNG declared as `audio/mpeg` gets 400). Also prove the 20 MB limit, the preview for text files, sha256 parity with the JSON path, and that the artifact render test still passes.
- [ ] **Lanes:** focused attachment, artifact-render and composer tests, the Gateway typecheck, `pnpm verify:surface:regression` (composer).

## Decisions for the operator

- **D1. Files route: text only, or any file?** Today it is text only in practice; the Library labels it "Upload text file". Streaming makes binary uploads easy, but that is a product change: preview, the download content type and the Library copy.
  - **Recommended:** keep it text-only in PR 1, and make binary uploads a separate decision.
- **D2. Old JSON shape: keep for small bodies, or remove?** Every in-repo client moves in the same PR. Keeping JSON up to 1 MiB costs little and means an old client still works for small pastes, getting a clear 413 above that.
  - **Recommended:** keep it, capped at 1 MiB.
- **D3. Metadata in the query string, or in headers?**
  - Query strings are simplest, and Fastify validates them with the same zod schemas.
  - Headers keep file names out of URLs, but need percent-encoding for non-ASCII names.
  - **Recommended:** the query string. File paths, session ids and file names are not secrets, and they already appear in other Gateway URLs, for example `/api/v1/files/download?relativePath=…`.

## Risks

- **Fastify does not enforce `bodyLimit` for a stream parser.** The helper must count bytes itself. A test sends a body larger than its `Content-Length`, and one with no `Content-Length`.
- **Windows file locking:** antivirus or the indexer can briefly hold a fresh staging file, so a rename can fail with `EPERM` or `EBUSY`. Retry the move a few times with a short backoff before failing, and always clean up the staging file.
- **Staging leftovers after a crash:** sweep `.goatcitadel-uploads` files older than one hour at Gateway start.
- **The idempotency fingerprint no longer covers the body bytes.** A client that reuses a key with different bytes gets the first attempt's receipt. That matches the vault and credential routes' rule. The optional `X-Content-SHA256` closes the gap when clients send it.
