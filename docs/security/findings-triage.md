# GitHub Security Findings — Triage Reference

Last updated: 2026-07-25

This document explains how to triage the recurring categories of GitHub Security findings against this repo and how to fix them **once** without rediscovering the same root cause every time. New AI agents (Claude, Codex, Copilot review bots) and human contributors should read this before opening a PR that touches rate-limit configuration, stream pipeline error handling, Dependabot alerts, the secret-scanning allowlist, or the synthetic-token fixtures used by the secret-redaction tests.

This document supersedes ad-hoc dismissals. It does not override [SECURITY.md](../../SECURITY.md) or [AGENTS.md](../../AGENTS.md).

---

## TL;DR for AI agents

Before opening a PR that touches any of these areas, stop and read the matching section below:

| If the alert / change involves… | Read |
|---|---|
| CodeQL rule `js/missing-rate-limiting` on a Fastify route | [§1](#1-codeql-jsmissing-rate-limiting-on-gateway-routes) |
| `.github/secret_scanning.yml` | [§2](#2-secret-scanning-yml--narrow-allowlist) |
| The token-shaped strings in `apps/gateway/src/services/improvement-common.redaction.security.test.ts` | [§3](#3-synthetic-token-fixtures-in-the-redaction-tests) |
| A "looks-like-a-secret" string anywhere else in `apps/` or `packages/` | [§4](#4-other-secret-scanning-matches) |
| Dependabot version/security alerts | [§5](#5-dependabot-triage) |
| CodeQL rule `js/unhandled-error-in-stream-pipeline` | [§6](#6-codeql-jsunhandled-error-in-stream-pipeline) |
| Anything under **Security → Code quality** (Standard or AI findings) | [§7](#7-code-quality-standard-findings) / [§8](#8-code-quality-ai-findings) |

Do not:

- Bulk-dismiss new `js/missing-rate-limiting` alerts without applying the per-route fix below. Dismissals do not prevent recurrence; the rule will refire on the next new route.
- Broaden `secret_scanning.yml` to cover entire test directories. The current narrow scope is intentional.
- "Rotate", redact, or "clean up" the synthetic Telegram-bot-token-shaped string in the redaction test. It is load-bearing; replacing it with a non-token-shaped placeholder breaks the test's purpose.
- Dismiss a secret-scanning alert with reason `used_in_tests` without first verifying every match in the flagged file is a deliberately-fake placeholder.

---

## 1. CodeQL `js/missing-rate-limiting` on gateway routes

### Why CodeQL keeps flagging these

The gateway registers `@fastify/rate-limit` with `global: false` and uses an `onRoute` hook in [`apps/gateway/src/app.ts`](../../apps/gateway/src/app.ts) (search for `addHook("onRoute")`) to auto-classify every route into a per-IP bucket:

| Bucket | Default `max` / minute | Triggers when… |
|---|---:|---|
| `auth` | 60 | URL matches the auth-route classifier |
| `mutation` | 180 | Method is POST/PUT/PATCH/DELETE |
| `sse` | 45 | Route is an SSE stream |
| `general` | 500 | Everything else (typically GET) |

The hook also wraps any explicit per-route `max` with `Math.min(explicitMax, bucketDefault)`, so an explicit value equal to the bucket default is a behavioural no-op.

CodeQL cannot statically follow the dynamic `routeOptions.config.rateLimit` injection performed by the hook, so it flags every route handler that does not carry a literal `config.rateLimit` block at the call site — regardless of whether the global limiter actually covers it at runtime.

**Runtime behaviour is correct.** The fix is to make the static structure visible to the analyzer, not to change behaviour.

### The fix pattern (do this, not dismissal)

For each flagged route, convert the shorthand `fastify.METHOD(path, handler)` form to the options-object form and pass a literal `config.rateLimit.max` matching the bucket default for the method:

```ts
// before — flagged by CodeQL
fastify.post("/api/v1/tools/grants", async (request, reply) => { ... });

// after — same runtime behaviour, CodeQL sees the literal
fastify.post(
  "/api/v1/tools/grants",
  { config: { rateLimit: { max: RATE_LIMIT_MUTATION_MAX } } },
  async (request, reply) => { ... },
);
```

Module-level constants live at the top of each route file. Existing examples:

- [`apps/gateway/src/routes/tools.ts`](../../apps/gateway/src/routes/tools.ts) — `RATE_LIMIT_GENERAL_MAX = 500`, `RATE_LIMIT_MUTATION_MAX = 180`
- [`apps/gateway/src/routes/tasks.ts`](../../apps/gateway/src/routes/tasks.ts) — `KANBAN_MUTATION_RATE_LIMIT_MAX = 180`
- [`apps/gateway/src/routes/auth.ts`](../../apps/gateway/src/routes/auth.ts), [`admin.ts`](../../apps/gateway/src/routes/admin.ts), [`integrations-slack-oauth-routes.ts`](../../apps/gateway/src/routes/integrations-slack-oauth-routes.ts) — same pattern, file-local constants

Pick the constant whose value equals the bucket default for the method (mutation→180 for POST/PUT/PATCH/DELETE; general→500 for GET). Do not invent lower values without an explicit security reason; the `Math.min` in `app.ts` will silently tighten the cap and may surprise callers.

### Special case: routes that use a shared options helper

`integration-webhooks-shared.ts` exports `createWebhookRouteOptions()` which already sets `config.rateLimit.max: 500`. CodeQL still flags routes that consume the helper because the rate-limit value is hidden behind a function call. The fix is to spread the helper's output and re-state `rateLimit` literally at the call site:

```ts
const opts = createWebhookRouteOptions("genericChannelRawBody");
fastify.post(path, {
  ...opts,
  config: { ...opts.config, rateLimit: { max: GENERIC_CHANNEL_INBOUND_RATE_LIMIT_MAX } },
}, handler);
```

See [`apps/gateway/src/routes/integration-webhooks.ts`](../../apps/gateway/src/routes/integration-webhooks.ts) for the canonical example.

### Per-route limiter lower than the bucket default

If a route legitimately needs a tighter cap than the bucket default (e.g., the existing `SLACK_OAUTH_RATE_LIMIT_MAX = 60` in `integrations-slack-oauth-routes.ts`), set the explicit value and add a one-line comment naming the reason. `Math.min` ensures the tighter value wins.

### When dismissal IS the right answer

If a future alert is genuinely a false positive that the per-route fix cannot suppress (e.g., a route registered through unusual indirection that CodeQL still cannot trace after the fix), dismiss as `false positive` with a comment that:

1. Cites this document.
2. Cites the line(s) where the rate limit is actually applied at runtime.
3. Cites the `app.ts` `onRoute` hook as the global coverage proof.

Do not dismiss as `won't fix` — that hides the alert from future audits without preserving the reasoning.

### Historical baseline

Alerts #102–#143 were dismissed as `false positive` before this document existed. Alerts #159–#169 were fixed via [PR #22](https://github.com/goatcitadel/GoatCitadel/pull/22) using the per-route pattern above. All future alerts of this rule on `apps/gateway/src/routes/**` should follow PR #22's approach unless a new structural exception applies.

---

## 2. `secret_scanning.yml` — narrow allowlist

[`.github/secret_scanning.yml`](../../.github/secret_scanning.yml) currently allowlists exactly **one file path** plus two dedicated fixture directory globs (`**/__fixtures__/**`, `**/__snapshots__/**`).

### Rules for changes to this file

1. **Never** add a glob that covers source code, e.g. `**/*.test.ts`, `**/test/**`, `**/*.spec.ts`. A real credential pasted into a future integration test (a common copy-paste mistake) must still alert.
2. To allowlist a new file, first prove every match in that file is a deliberately-fake placeholder. The file's tokens must be either:
   - Self-evidently fake (e.g., `0000`, `XXXX`, `EXAMPLE_TOKEN_…`), or
   - Shaped like a real token but constructed so it cannot collide with a credential a provider would actually issue (the redaction-test fixture is the canonical case).
3. Update the file's leading comment to explain *why* the new path is safe, with a date and reviewer initials.
4. After adding a path, run `git grep -nE '(sk-(proj|live)-|ghp_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{16}|xox[abp]-)'` on the newly-allowlisted scope to confirm no real-shaped tokens slipped in.

### What to do when a new secret alert fires

1. Read the alert's flagged line. Identify whether the match is a real secret or a fixture.
2. If real: rotate the credential immediately, force-remove from history, then close the alert as `revoked`.
3. If fixture in the already-allowlisted file: close the alert as `used_in_tests` (the allowlist only prevents *future* matches; existing alerts must be closed individually).
4. If fixture in a new file: prefer moving the fixture into `**/__fixtures__/**`, or replacing it with a self-evidently fake placeholder, **before** considering an allowlist addition.

---

## 3. Synthetic token fixtures in the redaction tests

[`apps/gateway/src/services/improvement-common.redaction.security.test.ts`](../../apps/gateway/src/services/improvement-common.redaction.security.test.ts) contains deliberately token-shaped strings (Telegram bot token, `sk-proj-…`, `ghp_…`, AWS access keys, email addresses) used to verify that the secret-redaction function in the improvement-ledger pipeline correctly scrubs each pattern before content leaves the gateway.

### Do not "fix" these strings

A future agent reading the file in isolation may see what looks like a hardcoded secret and try to remove or replace it with `<TOKEN>`-style placeholders. **This breaks the test's purpose.** The redactor's correctness can only be demonstrated against inputs that match the shape of the secrets it claims to redact. The fixture file is allowlisted in `secret_scanning.yml` precisely so this contradiction can coexist.

If the redactor learns to scrub a new pattern, add the matching fixture token here using the same conventions (clearly outside any real provider's issued-keyspace, e.g., leading `1234567890` octet for Telegram). Do not move the fixtures outside this file unless you also update the allowlist.

---

## 4. Other secret-scanning matches

For any secret-scanning alert *not* in a file covered by §3 or `secret_scanning.yml`:

1. Treat it as a real leak until proven otherwise.
2. Do not preemptively close the alert. Follow [SECURITY.md](../../SECURITY.md) reporting/rotation guidance.
3. If after investigation it is genuinely a test fixture, prefer relocating to `**/__fixtures__/**` over expanding the allowlist (per §2 rule 4).

---

## 5. Dependabot Triage

Dependabot alerts are actionable dependency findings, but this repo still needs the same scope discipline as code-scanning fixes:

1. Read the affected package name, vulnerable range, patched range, and dependency path in GitHub before editing.
2. Prefer the smallest lockfile/package update that moves the affected package into the patched range without changing unrelated dependency families.
3. If the dependency is transitive, update the nearest direct dependency only when that is the documented path to the patched transitive version.
4. Run the package-specific test/typecheck lane for the owner that imports the dependency, plus any named repo verification lane when the package is runtime, installer, auth, policy, storage, or Code Mode critical.
5. Do not dismiss a Dependabot alert solely because the vulnerable package is used in dev tooling. Dismiss only with evidence that the vulnerable code path is unreachable in this repo and record that evidence in the dismissal comment.

---

## 6. CodeQL `js/unhandled-error-in-stream-pipeline`

This alert means CodeQL found a `stream.pipeline(...)` call whose returned promise or callback error path is not visibly handled.

Current repo pattern:

1. Prefer `await pipeline(...)` inside `try/catch` when already in an async handler.
2. For fire-and-forget response streaming, use `void pipeline(...).catch((error) => { ... })` and make the catch path avoid writing headers after the response is already destroyed or sent.
3. For child-process log streams, wrap the pipeline promises in `Promise.all([...]).catch(...)` and preserve the failure in the surrounding process result when the caller needs verification truth.
4. Do not silence the alert with an empty catch. Either log an operator-visible diagnostic, return a failed verification result, or safely terminate the response.
5. Validate with a focused test or by running the owning script/lane, then query the CodeQL alert state before dismissing.

Live query pattern:

```powershell
gh api --paginate "repos/goatcitadel/GoatCitadel/code-scanning/alerts?state=open&per_page=100" --jq '.[] | select(.rule.id=="js/unhandled-error-in-stream-pipeline")'
```

If the query is empty and local `pipeline(...)` call sites are visibly awaited or caught, treat the rule as currently clear. If GitHub still shows an alert for already-handled code, dismiss as `false positive` only with a comment naming the exact local handler and the validation/query evidence.

---

## 7. Code Quality — Standard findings

**Code Quality is a different product from code scanning.** Findings under
`https://github.com/goatcitadel/GoatCitadel/security/quality` are *not* returned by the
`code-scanning/alerts` REST API, and there is no GraphQL surface for them either. Probing
`repos/.../code-quality/alerts` returns 404. The only way to enumerate them is the web UI:

- Standard findings (full CodeQL scan): `/security/quality`, then `/security/quality/rules/<url-encoded rule id>`
- AI findings (recently-changed files): `/security/quality/ai-findings`

Do not report "no quality findings" on the strength of an empty `code-scanning/alerts` query.

### Rules seen so far and the fix pattern for each

| Rule | Category | Fix pattern |
|---|---|---|
| `js/useless-assignment-to-local` | Maintainability | Delete the dead write. When the right-hand side is a call with durable side effects (e.g. `summaryRepo.recordCompactionNoProgress`), keep the call and drop only the assignment, with a comment naming why the result is discarded. |
| `js/comparison-between-incompatible-types` | Reliability | **First decide which of two cases you have.** (a) The check is *load-bearing* and the alert is a narrowing-order artifact — put the `=== null` / `!== undefined` test **before** the `typeof x === "object"` guard so the compared operand is still unnarrowed (`canonical-json.ts`). (b) The check is genuinely *unreachable* because an earlier `return`/`break` already excluded that value — delete it and comment the invariant (`mcp-requester-resolution.ts`, `remote-worker-native-tls-listener.ts`). Reordering a case-(b) site only moves the alert; the rule refires with a different message ("cannot be of type null" rather than "is of type object … compared to null"). Read the whole function before choosing. |
| `js/superfluous-trailing-arguments` | Reliability | Do **not** delete the argument at the call site. `FastifyPluginAsync` declares two *required* parameters, so `routes(fastify as never)` fails typecheck with TS2554. Fix the plugin instead: declare the ignored second parameter as `_opts` (allowed by the `argsIgnorePattern: "^_"` rule in `eslint.config.js`). |

Applied examples live in [`apps/gateway/src/services/chat-message-history-service.ts`](../../apps/gateway/src/services/chat-message-history-service.ts),
[`packages/contracts/src/canonical-json.ts`](../../packages/contracts/src/canonical-json.ts), and
[`apps/gateway/src/routes/runtime-authority.ts`](../../apps/gateway/src/routes/runtime-authority.ts).

Each fixed site carries an inline comment naming the rule, so a later "cleanup" pass does not
silently revert the analyzer-visible form back into the flagged one. Preserve those comments.

---

## 8. Code Quality — AI findings

These are Copilot suggestions over recently-changed files, not CodeQL results. They arrive as a
pre-built diff with an "Open pull request" button.

**Verify the stated premise against the source before applying any of them.** Every AI finding
triaged on 2026-07-25 except one was a false positive, and in two cases applying the offered diff
would have broken a passing test:

| Reported | Why it was wrong |
|---|---|
| `ThreadedTimeline.loop25.test.tsx` — "`createElement(C, { props })` should spread the props" | `ThreadedTimeline` genuinely destructures a prop *named* `props`. The offered diff breaks the component contract. |
| `capability-system-service.test.ts` — "the second run reuses the first run's approval" | The harness `approvals` Map is keyed by `approvalId`, so the second `createApproval` overwrites the entry; the second execute resolves the second run. The offered diff also reads `.value.id`, a field that does not exist (the field is `approvalId`, and an async mock's `mock.results[].value` is a Promise). |
| `llm-service.test.ts` — "`/v1` should not be appended to a path-carrying base URL" | `shouldAppendV1` appends `/v1` to every path that is not already version-suffixed; bare roots are one case, not the only one. The expectation matches intended behaviour. |
| `run-ts7-workspace.mjs` — "`mode` never alters the command" | Correct observation, intended design. The comment above `runTypeScriptCommand` explains that composite project references reject `--noEmit`. The offered diff also removed `--force` from build mode, which is a behaviour change. |

The one accepted suggestion was a genuine naming/semantics issue: `dedupeProjects` was being reused
to deduplicate group *names* while applying path separator normalization. It was split into a
generic `dedupeValues` plus a path-normalizing `dedupeProjects`.

Confirm a suggestion by reading the implementation it describes — and, for test findings, by
running the test — before opening the offered pull request.

---

## References

- Implementation: [PR #22 — fix(security): explicit rate-limit configs on gateway routes + test-fixture secret-scan exclusion](https://github.com/goatcitadel/GoatCitadel/pull/22)
- Gateway rate-limit wiring: [`apps/gateway/src/app.ts`](../../apps/gateway/src/app.ts) (search `addHook("onRoute")` and `resolveRateLimitConfig`)
- Helper for webhook route options: [`apps/gateway/src/routes/integration-webhooks-shared.ts`](../../apps/gateway/src/routes/integration-webhooks-shared.ts)
- Top-level policy: [`SECURITY.md`](../../SECURITY.md)
- Agent conventions: [`AGENTS.md`](../../AGENTS.md)
