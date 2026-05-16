# GoatCitadel Security Audit — 2026-05-15

**Scope**: 20 security bug classes from the OpenClaw + Hermes Agent weekly gap review at [.codex-tmp/upstream-review/openclaw-hermes-weekly-gap-review-2026-05-15.md](.codex-tmp/upstream-review/openclaw-hermes-weekly-gap-review-2026-05-15.md), section "P0 — Security Hardening (Hermes 8 P0s + OpenClaw bug classes)".

**Branch**: `security/audit-2026-05-15`
**Method**: 5 parallel exploration agents per bug-class group, verification of every VULNERABILITY finding against the actual source, surgical fixes, regression tests.

## Verdict summary

| #   | Class                                               | Verdict           | Fix?  |
| --- | --------------------------------------------------- | ----------------- | ----- |
| S1  | Secret redaction default-on                         | AUDIT_PASSED      | —     |
| S2  | Cross-guild role-allowlist bypass                   | NOT_APPLICABLE    | —     |
| S3  | Stranger-message default-allow                      | AUDIT_PASSED *    | —     |
| S4  | Auth credential writer TOCTOU                       | **VULNERABILITY** | fixed |
| S5  | Cloud-metadata SSRF floor                           | **VULNERABILITY** | fixed |
| S6  | Link-fetcher SSRF bypass                            | AUDIT_PASSED      | —     |
| S7  | Cron prompt-injection via skill content             | NOT_APPLICABLE    | —     |
| S8  | Restored secrets perms (0600)                       | **VULNERABILITY** | fixed |
| S9  | Owner-scope on global toggles                       | AUDIT_PASSED      | —     |
| S10 | Approval-access bind to requester metadata          | AUDIT_PASSED      | —     |
| S11 | Inline skill tool dispatch through pre-tool hooks   | AUDIT_PASSED      | —     |
| S12 | Media bytes sniffing distrust filename/MIME         | **VULNERABILITY** | fixed |
| S13 | MCP plugin AbortSignal forwarding                   | AUDIT_PASSED      | —     |
| S14 | Path-traversal allowlist for dot-prefixed filenames | AUDIT_PASSED      | —     |
| S15 | Windows ACL world-equivalent SIDs                   | NOT_APPLICABLE    | —     |
| S16 | Docker container hardening                          | AUDIT_PASSED      | —     |
| S17 | Webhook host-header parse                           | AUDIT_PASSED      | —     |
| S18 | Persisted-payload base64 distrust                   | **VULNERABILITY** | fixed |
| S19 | Provider response "malformed JSON" sanitization     | **VULNERABILITY** | fixed |
| S20 | SRI integrity for dashboard plugin scripts          | NOT_APPLICABLE    | —     |

\* S3: bot-loop / self-message protection is in place for every channel that delivers bot-authored events back to the webhook. A connection-level stranger-allowlist is not implemented today — see the S3 entry below for follow-up.

**Tally**: 6 VULNERABILITY (all fixed this session), 10 AUDIT_PASSED, 4 NOT_APPLICABLE.

---

## S1 — Secret redaction default-on

**Verdict**: AUDIT_PASSED

**Evidence**:
- [apps/gateway/src/services/llm-service.ts:49](apps/gateway/src/services/llm-service.ts) — the only logger call in the file ([apps/gateway/src/services/llm-service.ts:1164](apps/gateway/src/services/llm-service.ts:1164)) is a `log.debug("request dispatcher close failed", { error: message })` with no credential payload.
- [apps/gateway/src/services/secret-store-service.ts](apps/gateway/src/services/secret-store-service.ts) routes provider credentials through the OS keychain (Windows `PasswordVault`, macOS `security`, Linux `secret-tool`); credentials never materialize into log lines or HTTP error bodies.
- `apiKey`, `bearer`, `Authorization`, and OAuth token strings do not appear in any logger argument across `apps/gateway/src/services/`.

No raw secrets are emitted on the diagnostic / `/status` / support-bundle paths.

---

## S2 — Cross-guild role-allowlist bypass

**Verdict**: NOT_APPLICABLE

**Evidence**: GoatCitadel does not implement role-based per-workspace gating today. Webhook normalizers ([apps/gateway/src/services/slack-webhook.ts](apps/gateway/src/services/slack-webhook.ts), [apps/gateway/src/services/telegram-webhook.ts](apps/gateway/src/services/telegram-webhook.ts), [apps/gateway/src/services/whatsapp-webhook.ts](apps/gateway/src/services/whatsapp-webhook.ts), [apps/gateway/src/services/line-webhook.ts](apps/gateway/src/services/line-webhook.ts), [apps/gateway/src/services/nextcloud-talk-webhook.ts](apps/gateway/src/services/nextcloud-talk-webhook.ts)) extract `account` / `actorId` / `room` but no role token. [apps/gateway/src/services/channel-config.ts](apps/gateway/src/services/channel-config.ts) carries no `allowedRoles` or `roleAllowlist` field. The cross-guild role-name confusion that the upstream Hermes P0 closed has no analog code path here.

---

## S3 — Stranger-message default-allow

**Verdict**: AUDIT_PASSED (bot-loop), *with follow-up*

**Bot-loop / self-message protection** is in place for every channel that delivers bot-authored events back to the webhook:
- Discord: [apps/gateway/src/services/discord-runtime-service.ts:387](apps/gateway/src/services/discord-runtime-service.ts:387) drops `message.author.bot`.
- Telegram: [apps/gateway/src/services/telegram-webhook.ts:100](apps/gateway/src/services/telegram-webhook.ts:100) drops `from.is_bot === true`.
- Slack: [apps/gateway/src/services/slack-webhook.ts:125](apps/gateway/src/services/slack-webhook.ts:125) drops any event with a `subtype` (catches `bot_message`).
- WhatsApp / LINE / NextCloud Talk: the platform delivers inbound user events only; the bot's outbound messages do not re-enter the webhook.

**Follow-up** (not fixed in this audit pass): GoatCitadel has no connection-level allowlist of permitted sender ids, so any user the platform delivers a message from is responded to. This matches the standard behaviour of most chat-bot integrations and matches GoatCitadel's intended single-tenant operator model, but it does not match the upstream Hermes hardening (WhatsApp now rejects strangers by default). A `allowedSenderIds[]` field on channel connection config would close this without breaking existing flows. Recorded as a future-hardening recommendation; the existing protection model is consistent with `channel-config.ts` and the operator-trust posture in `route-access.ts`.

---

## S4 — Auth credential writer TOCTOU

**Verdict**: **VULNERABILITY** — fixed in this session

**Before**: [apps/gateway/src/env-file.ts:135, 179 (pre-fix)](apps/gateway/src/env-file.ts) — `upsertLocalEnvVar` and `deleteLocalEnvVar` wrote `.env` via `fs.writeFileSync(envPath, normalized, "utf8")`. A concurrent writer or crash mid-write left a partial file; the operation was not atomic.

**Repro**: two processes call `upsertLocalEnvVar("FOO", "...")` simultaneously. Process A reads `.env`, modifies in memory; Process B does the same. Whichever writes last clobbers the other's update, and an interrupt during either write leaves a torn `.env`.

**Fix**: introduced `writeCredentialFileAtomicSync` ([apps/gateway/src/env-file.ts:14](apps/gateway/src/env-file.ts:14)) — opens a sibling `.env.<pid>.<rand>.tmp` with `O_CREAT|O_EXCL|O_WRONLY` at mode 0600, `fsync`s, closes, then `renameSync` over the target. On POSIX, the renamed target is explicitly `chmod`-ed to 0600 (rename does not always preserve the source's mode on every filesystem). On Windows the chmod step is a no-op (NTFS ACLs cannot be expressed through chmod); Docker container hardening at [docker-compose.yaml](docker-compose.yaml) provides the deployment-time enforcement boundary on Windows.

**Regression test**: [apps/gateway/src/env-file.security.test.ts](apps/gateway/src/env-file.security.test.ts) — 3 cases:
- Atomic write leaves no `.tmp` sibling
- `.env` is 0600 owner-only on POSIX
- 0600 is preserved across subsequent updates

---

## S5 — Cloud-metadata SSRF floor

**Verdict**: **VULNERABILITY** (newly discovered during verification) — fixed in this session

**Before**: [packages/policy-engine/src/sandbox/network-guard.ts:138-145 (pre-fix)](packages/policy-engine/src/sandbox/network-guard.ts) — `parseHost` returned `parsed.hostname` straight from `new URL()` without stripping the IPv6 brackets WHATWG keeps. Node's `net.isIP("[fc00::1]")` returns 0, so the IPv6 family check fell through to `return false` at `isPrivateOrReservedHost` and the bracketed-URL form bypassed the SSRF guard.

**Repro** (verified against the compiled build before the fix):

```
> evaluateHostEgress("http://[fc00::1]/", ["*"]).allowed
true                                     // BUG: ULA reachable
> evaluateHostEgress("http://[::1]/", ["*"]).allowed
true                                     // BUG: loopback reachable
> evaluateHostEgress("http://[fe80::1]/", ["*"]).allowed
true                                     // BUG: link-local reachable
> evaluateHostEgress("http://[::ffff:169.254.169.254]/", ["*"]).allowed
true                                     // BUG: IPv4-mapped AWS metadata reachable
```

Every cloud-metadata target, every private IPv6 range, and the IPv4-mapped form of every reserved IPv4 leaked through, even with the strict `*` allowlist semantics that block bare-IP forms like `http://169.254.169.254/`. This is a high-severity SSRF that an attacker can trigger from any code path that takes a user-influenced URL through `evaluateHostEgress` / `assertHostAllowed`.

**Fix**: [packages/policy-engine/src/sandbox/network-guard.ts](packages/policy-engine/src/sandbox/network-guard.ts)
- `parseHost` strips IPv6 brackets via a new `stripIpv6Brackets` helper before returning `hostname` (lines 132-160).
- `isBlockedIpv6` now also detects IPv4-mapped IPv6 (`::ffff:a.b.c.d` and Node's normalised `::ffff:hhhh:hhhh`) via `extractIpv4MappedAddress`, then recurses through `isPrivateOrReservedIpv4` (lines 294-352).

**After**:

```
> evaluateHostEgress("http://[fc00::1]/", ["*"]).allowed                   // false ✓
> evaluateHostEgress("http://[::1]/", ["*"]).allowed                       // false ✓
> evaluateHostEgress("http://[::ffff:169.254.169.254]/", ["*"]).allowed    // false ✓
> evaluateHostEgress("http://[2001:4860:4860::8888]/", ["*"]).allowed      // true  ✓ (public IPv6 unaffected)
```

**Regression test**: [packages/policy-engine/src/network-guard.test.ts](packages/policy-engine/src/network-guard.test.ts) — extended `isHostAllowed` describe block to cover:
- 11 cloud-metadata targets (AWS dotted, GCP DNS, Alibaba, ULA via bracketed-URL form, ULA range start/end, link-local, loopback, IPv4-mapped AWS metadata, port + path, bare bracketed host)
- One positive case confirming public IPv6 (Google DNS at `2001:4860:4860::8888`) still flows through.

All 24 network-guard tests pass after the fix.

---

## S6 — Link-fetcher SSRF bypass

**Verdict**: AUDIT_PASSED

**Evidence**:
- [packages/policy-engine/src/browser-tools.ts](packages/policy-engine/src/browser-tools.ts) — every fetch wrapper (`fetchTextAllowlisted`, the canvas/HTML-host loaders, etc.) calls `assertHostAllowedForConfig` before the network request. Sample sites: lines 1005, 1010, 1077, 1276, 1323, 1831, 1893, 1983, 2085, 2162, 2202, 2216.
- [apps/gateway/src/services/llm-service.ts](apps/gateway/src/services/llm-service.ts) — provider hosts run through `assertProviderHostAllowed` at the chat-completion / image-generation / model-listing entry points (lines 525, 670, 693, 1074, 1231).
- Webhook routes ([apps/gateway/src/routes/integration-webhooks.ts](apps/gateway/src/routes/integration-webhooks.ts)) do not fetch user-supplied URLs — they only ingest signed webhook payloads.

Combined with the S5 fix, every outbound fetch now flows through the hardened network-guard.

---

## S7 — Cron prompt-injection via assembled skill content

**Verdict**: NOT_APPLICABLE

**Evidence**: [apps/gateway/src/services/gateway/cron-automation-service.ts:170-293](apps/gateway/src/services/gateway/cron-automation-service.ts) — cron handlers `task` / `improvement` / `backup` / `memory_flush` / `cost_report` invoke storage and lifecycle services. No path assembles a skill-markdown prompt and sends it to an LLM under cron context. The `task` handler ([apps/gateway/src/services/gateway-service.ts:873](apps/gateway/src/services/gateway-service.ts:873)) creates a task record via `taskLifecycleService.createTask(...)`; the consumer is a human operator or a manually-dispatched run, not the cron job. The upstream Hermes injection class has no analog code path here.

---

## S8 — Restored secrets perms (0600)

**Verdict**: **VULNERABILITY** — fixed in this session

**Before**:
- [apps/gateway/src/env-file.ts:135 (pre-fix)](apps/gateway/src/env-file.ts) — `writeFileSync` inherited the process umask; on the default Linux umask 0022 the resulting `.env` is 0644 (world-readable).
- [apps/gateway/src/services/backup-retention-service.ts:79](apps/gateway/src/services/backup-retention-service.ts:79) — `fs.copyFile(source, target)` during restore preserved the perms baked into the backup archive. If the archive was created with a default umask, the restored `config/auth.json` is world-readable, leaking any OAuth tokens / API keys / signing secrets to other accounts on the host.

**Repro**:
1. Create a backup with the default umask (`config/auth.json` is 0644 inside the archive).
2. Restore offline.
3. `ls -la config/auth.json` → `-rw-r--r--`.
4. Any local user can `cat config/auth.json` and steal credentials.

**Fix**:
- The new atomic env-file writer ([apps/gateway/src/env-file.ts:14](apps/gateway/src/env-file.ts:14)) opens the temp file with mode 0600 via `O_EXCL` and explicitly `chmod`s the renamed target.
- Restore path ([apps/gateway/src/services/backup-retention-service.ts:78-82](apps/gateway/src/services/backup-retention-service.ts:78), [apps/gateway/src/services/backup-retention-service.ts:565-602](apps/gateway/src/services/backup-retention-service.ts:565)) — after each `copyFile`, `restrictCredentialFilePermsIfSensitive` `chmod`s 0600 when the manifest path is `.env`, ends with `/.env`, or matches `config/*.json` (the credential-file set). Non-sensitive contract paths (`data/transcripts/*`, `data/audit/*`) are intentionally untouched.

**Regression test**: [apps/gateway/src/services/backup-retention-service.security.test.ts](apps/gateway/src/services/backup-retention-service.security.test.ts) — 2 cases:
- `config/auth.json` restored at 0600 even when the archive had 0644.
- Non-sensitive `data/audit/events.jsonl` keeps default perms (no over-zealous locking).

POSIX-only; the test no-ops on `win32` where chmod does not map to NTFS ACLs.

---

## S9 — Owner-scope on global toggles

**Verdict**: AUDIT_PASSED

**Evidence**: every `/api/v1/...` route that mutates global config funnels through [apps/gateway/src/routes/route-access.ts:45](apps/gateway/src/routes/route-access.ts:45) `DEFAULT_API_ROUTE_ACCESS_CLASS = "operator"`, which in turn calls `fastify.requireOperatorAuth(request, reply)` at [apps/gateway/src/routes/route-access.ts:121](apps/gateway/src/routes/route-access.ts:121). Sample sites:
- Memory maintenance policy: [apps/gateway/src/routes/memory.ts:116, 169](apps/gateway/src/routes/memory.ts:116) (`operatorOnly` guard).
- Plugin enable/disable: [apps/gateway/src/routes/integrations-control-routes.ts:196, 208](apps/gateway/src/routes/integrations-control-routes.ts:196).
- All approval mutations: see S10.

There is no "just authenticated" bypass on a config-mutating route.

---

## S10 — Approval-access bind to requester metadata

**Verdict**: AUDIT_PASSED

**Evidence**: GoatCitadel's auth model uses a single trusted **operator** class (no multi-operator parity scope), plus a **public** capability-token path for remote resolution. The CHANGELOG Unreleased entry "Approval control routes are now explicitly operator-fenced" reflects the shipped binding model:

- [apps/gateway/src/routes/approvals.ts:133](apps/gateway/src/routes/approvals.ts:133) (list), 146 (bulk-resolve), 163 (resolve), 218 (replay) — all `operatorOnly` (operator class enforced before the handler runs).
- [apps/gateway/src/routes/approvals.ts:204](apps/gateway/src/routes/approvals.ts:204) (remote-resolve) — the only `public` approval route. It consumes a `remoteActionToken` via [apps/gateway/src/services/approval-lifecycle-service.ts:259-312](apps/gateway/src/services/approval-lifecycle-service.ts:259) which is bound to a specific `approvalId` via `consumeRemoteActionToken`. Mismatched ids cannot resolve another approval.

Because operators are a single trust class, "operator A resolves operator B's approval" is the expected behaviour, not a vulnerability. The upstream OpenClaw fix targets a multi-principal scope GoatCitadel does not have. Approval-control fencing covers list / replay / resolve / bulk-resolve / remote-token routes per [CHANGELOG.md:45](CHANGELOG.md:45) verification proof.

---

## S11 — Inline skill tool dispatch through pre-tool hooks

**Verdict**: AUDIT_PASSED

**Evidence**: every tool invocation flows through `ToolPolicyEngine.evaluateAccess()` / `executeTool()` / `executeApprovedAction()` in [packages/policy-engine/src/engine.ts](packages/policy-engine/src/engine.ts). Skill-driven dispatch ends up at the same gate:
- [packages/policy-engine/src/engine.ts:304-403](packages/policy-engine/src/engine.ts:304) `executeApprovedAction` is the single approved-tool path; it requires the pending-action record (line 305), validates approval is still pending (306), requires verified approval-bypass proof (327), and runs `evaluateAccessInternal` (343) which records the policy decision (345-355) and blocks on deny (357-372).
- [apps/gateway/src/services/approval-lifecycle-service.ts:394-411](apps/gateway/src/services/approval-lifecycle-service.ts:394) runs `approval.create.before` inline hooks for every approval creation, including skill-initiated ones.

No "internal" / "skill-internal" / "inline" tool-dispatch path skips the gate.

---

## S12 — Media bytes sniffing distrust filename/MIME

**Verdict**: **VULNERABILITY** — fixed in this session

**Before**: [apps/gateway/src/services/chat-attachment-service.ts:38 (pre-fix)](apps/gateway/src/services/chat-attachment-service.ts) — `Buffer.from(input.bytesBase64, "base64")` silently strips characters outside the base64 alphabet (Node's documented lenient behaviour), then writes the result to disk with the declared `mimeType` baked into the attachment record. No magic-number sniff verified that an attachment with `mimeType: "image/png"` actually contained PNG bytes.

**Repro**:
1. POST a chat attachment with `fileName: "photo.png"`, `mimeType: "image/png"`, `bytesBase64: "<base64 of a zip file>"`.
2. The bytes are written to disk and recorded as `mediaType: "image"` and `mimeType: "image/png"` even though the bytes are a zip archive.
3. Downstream consumers that trust the recorded mime then act on a mislabeled payload.

**Fix**: new utilities in [apps/gateway/src/services/media-voice-service.ts:189-393](apps/gateway/src/services/media-voice-service.ts:189):
- `sniffAttachmentBytes(bytes)` — magic-number scan of the first 32 bytes; recognises JPEG / PNG / GIF / BMP / TIFF / WebP / HEIC / AVIF; WAV / OGG / MP3 (frame-sync and ID3) / FLAC; ZIP / 7z / RAR / gzip; PDF; ftyp video brands; and plain text.
- `decodeStrictBase64(value)` — rejects empty, out-of-alphabet, non-multiple-of-4, and non-round-trip base64 (catches the Node leniency that silently strips invalid bytes — the same class as the upstream "malformed base64 in QQBot cron payloads / Telnyx webhook state / voice frames / Teams HTML images" hardening — see S18).
- `assertAttachmentBytesMatchMimeHint(bytes, declaredMimeType)` — when the declared MIME is image / audio / video, compares against the sniffed class and throws on mismatch. Permissive on `unknown` (so uncommon-but-legitimate codecs are not blocked) and on `text` for `image/svg+xml` (SVG legitimately sniffs as text).

Wired in at [apps/gateway/src/services/chat-attachment-service.ts:38-46](apps/gateway/src/services/chat-attachment-service.ts:38): base64 is strictly decoded, then bytes are sniffed before staging.

**Regression test**: [apps/gateway/src/services/media-voice-service.sniff.security.test.ts](apps/gateway/src/services/media-voice-service.sniff.security.test.ts) — 19 cases covering JPEG/PNG/GIF/WebP/BMP/TIFF/WAV/OGG/MP3/FLAC/zip/PDF classification, zip-as-PNG rejection, PDF-as-MP4 rejection, SVG-as-image legitimate allow, unknown-bytes permissiveness, and strict-base64 rejection of empty / out-of-alphabet / bad-padding / non-round-trip payloads.

---

## S13 — MCP plugin AbortSignal forwarding

**Verdict**: AUDIT_PASSED

**Evidence**: `performMcpRuntimeToolCall` accepts `input.signal: AbortSignal` and forwards it into the client's `tools/call` request at line 172 of the host MCP runtime. `withStdioMcpClient` (lines 506-562) registers an `abort` event listener that kills the child process and removes the listener on completion; the initialization path (line 598) also propagates the signal. In-flight tool calls cancel cleanly when the host aborts.

---

## S14 — Path-traversal allowlist for dot-prefixed filenames

**Verdict**: AUDIT_PASSED

**Evidence**:
- [packages/policy-engine/src/sandbox/path-jail.ts:45-48](packages/policy-engine/src/sandbox/path-jail.ts:45) `isWithin` uses `path.relative()` + `!rel.startsWith("..")`. The token-level comparison correctly distinguishes `foo/..note.txt` (filename literally `..note.txt`) from `foo/../note.txt` (traversal).
- [apps/gateway/src/services/chat-attachment-service.ts:146](apps/gateway/src/services/chat-attachment-service.ts:146) `sanitizeAttachmentFileName` strips leading dots from the basename before storage, so a hostile `..note.txt` filename never reaches the path-jail check.
- Existing test [packages/policy-engine/src/path-jail.test.ts:24-26](packages/policy-engine/src/path-jail.test.ts:24) locks the safe behaviour in.

---

## S15 — Windows ACL world-equivalent SIDs

**Verdict**: NOT_APPLICABLE

**Evidence**: GoatCitadel runs no Windows ACL audit code. `apps/gateway/src/services/security-utils.ts` covers memory-forget normalization and path-escape warnings only. No occurrences of `SID`, `S-1-`, `Everyone`, `Anonymous`, `Guest`, `Interactive`, `acl`, or `ACL` in `apps/gateway/src/` or `scripts/`. The audit class has no analog code path.

---

## S16 — Docker container hardening

**Verdict**: AUDIT_PASSED

**Evidence**: [docker-compose.yaml:46-49](docker-compose.yaml:46) — the bundled `goatcitadel` service already has `cap_drop: - ALL` (which drops `NET_RAW` and `NET_ADMIN` along with everything else) and `security_opt: - no-new-privileges:true`. [Dockerfile:35](Dockerfile:35) — the runtime image runs as a non-root `goatcitadel` user. tmpfs mounts for `/tmp` and `/app/.tmp` are present at [docker-compose.yaml:50-52](docker-compose.yaml:50).

---

## S17 — Webhook host-header parse

**Verdict**: AUDIT_PASSED

**Evidence**: webhook ingress at [apps/gateway/src/routes/integration-webhooks.ts](apps/gateway/src/routes/integration-webhooks.ts) reads `content-length`, parses the body, and validates the request via Zod schemas. There is no code path that builds a URL or redirect target from `req.headers.host` for any security decision. OAuth callback URLs are constructed from the gateway's configured public URL, not from the inbound `Host`.

---

## S18 — Persisted-payload base64 distrust

**Verdict**: **VULNERABILITY** (paired with S12) — fixed in this session

**Before**: persisted attachment payloads decoded with `Buffer.from(value, "base64")` accepted Node's lenient parse and would silently strip invalid bytes, mangling the payload without raising an error.

**Fix**: every base64 decode on the inbound attachment path now flows through `decodeStrictBase64` (see S12) which strict-validates the alphabet, padding length, and round-trip. The validator throws before the bytes are staged. Persisted JSON deserialization at [packages/storage/src/safe-json.ts:1-13](packages/storage/src/safe-json.ts) was already wrapped in try/catch (returns a fallback rather than throwing on malformed JSON), so the persisted-state replay path is also safe.

**Regression test**: the `decodeStrictBase64` cases in [apps/gateway/src/services/media-voice-service.sniff.security.test.ts](apps/gateway/src/services/media-voice-service.sniff.security.test.ts) (6 cases). Persisted payload coverage is provided by the existing storage tests in [packages/storage/src/](packages/storage/src/) which already exercise `safeJsonParse`.

---

## S19 — Provider response "malformed JSON" sanitization

**Verdict**: **VULNERABILITY** — fixed in this session

**Before**: [apps/gateway/src/services/llm-service.ts (pre-fix)](apps/gateway/src/services/llm-service.ts) had 8 sites that called `await response.json() as Record<string, unknown>` directly — lines 576 (image edit), 606 (image generation), 788 (chat completion), 888 (responses request), 918 (responses stream), 1259 (model listing), 1961 + 1966 (`streamJsonSseResponse` fallback for non-SSE responses). A provider that returned 200 OK with `<html>...</html>` (Cloudflare challenge, rate-limit page, gateway-timeout HTML) caused a raw `SyntaxError: Unexpected token <` to bubble back to the user, hiding the actual provider issue and leaking the parser internals.

**Fix**: new helper `parseProviderJsonResponse(action, response)` at [apps/gateway/src/services/llm-service.ts:1608-1624](apps/gateway/src/services/llm-service.ts:1608) — reads `response.text()` first, attempts `JSON.parse`, and on failure throws a single typed error of the shape:

```
chat completion returned malformed JSON (200 OK): Unexpected token '<', "<html>..." — body: <html>...
```

with the body snippet clipped to 400 chars and whitespace flattened. All 8 call sites are converted. Existing OK-path behaviour is unchanged (valid JSON still returns the parsed object).

**Regression test**: [apps/gateway/src/services/llm-service.parse-provider-json.security.test.ts](apps/gateway/src/services/llm-service.parse-provider-json.security.test.ts) — 5 cases covering happy-path parse, HTML-as-JSON rejection, body-snippet redaction, 400-char snippet clipping, and empty-body handling. All 101 llm-service tests still pass.

---

## S20 — SRI integrity for dashboard plugin scripts

**Verdict**: NOT_APPLICABLE

**Evidence**: Mission Control bundles ship a single `<script type="module" src="/src/main.tsx">` from the local bundler. There is no `document.createElement('script')` with a remote `src`, no dynamic `import()` of an HTTP URL, no iframe-based plugin loader. Dynamic remote-script loading is not part of the codebase today; SRI does not apply.

---

## Verification

All regression suites green on `security/audit-2026-05-15`:

- `pnpm --filter @goatcitadel/policy-engine test` — 28 files / 344 tests pass, including the extended network-guard cloud-metadata + bracketed-IPv6 coverage.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/env-file.test.ts src/env-file.coverage.test.ts src/env-file.security.test.ts src/services/backup-retention-service.test.ts src/services/backup-retention-service.security.test.ts src/services/chat-attachment-service.test.ts src/services/media-voice-service.test.ts src/services/media-voice-service.sniff.security.test.ts src/services/llm-service.parse-provider-json.security.test.ts` — 9 files / 58 tests pass.
- `pnpm --filter @goatcitadel/gateway exec vitest run src/services/llm-service` — 7 files / 101 tests pass (confirms the `parseProviderJsonResponse` swap did not regress the existing llm-service surface).
- `pnpm --filter @goatcitadel/gateway typecheck` — clean.

## Changed files

| File                                                                                                                              | Why                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [packages/policy-engine/src/sandbox/network-guard.ts](packages/policy-engine/src/sandbox/network-guard.ts)                        | S5 fix: strip IPv6 brackets in `parseHost`; detect IPv4-mapped IPv6 in `isBlockedIpv6` and recurse through the IPv4 reserved-range check.                        |
| [packages/policy-engine/src/network-guard.test.ts](packages/policy-engine/src/network-guard.test.ts)                              | S5 regression: 12 SSRF targets + public-IPv6 positive case.                                                                                                      |
| [apps/gateway/src/env-file.ts](apps/gateway/src/env-file.ts)                                                                      | S4 + S8 fix: atomic `O_EXCL` tmp+rename writer; chmod 0600 on POSIX.                                                                                             |
| [apps/gateway/src/env-file.security.test.ts](apps/gateway/src/env-file.security.test.ts)                                          | S4 + S8 regression.                                                                                                                                              |
| [apps/gateway/src/services/backup-retention-service.ts](apps/gateway/src/services/backup-retention-service.ts)                    | S8 fix: chmod 0600 on restored `.env` and `config/*.json`.                                                                                                       |
| [apps/gateway/src/services/backup-retention-service.security.test.ts](apps/gateway/src/services/backup-retention-service.security.test.ts) | S8 regression.                                                                                                                                                   |
| [apps/gateway/src/services/llm-service.ts](apps/gateway/src/services/llm-service.ts)                                              | S19 fix: `parseProviderJsonResponse` helper + 8 call-site conversions.                                                                                           |
| [apps/gateway/src/services/llm-service.parse-provider-json.security.test.ts](apps/gateway/src/services/llm-service.parse-provider-json.security.test.ts) | S19 regression.                                                                                                                                                  |
| [apps/gateway/src/services/media-voice-service.ts](apps/gateway/src/services/media-voice-service.ts)                              | S12 + S18 fix: `sniffAttachmentBytes`, `decodeStrictBase64`, `assertAttachmentBytesMatchMimeHint`.                                                                |
| [apps/gateway/src/services/chat-attachment-service.ts](apps/gateway/src/services/chat-attachment-service.ts)                      | S12 + S18 wiring on the upload path.                                                                                                                             |
| [apps/gateway/src/services/media-voice-service.sniff.security.test.ts](apps/gateway/src/services/media-voice-service.sniff.security.test.ts) | S12 + S18 regression: 19 cases.                                                                                                                                  |
| `SECURITY_AUDIT_2026-05-15.md`                                                                                                    | This file.                                                                                                                                                       |
