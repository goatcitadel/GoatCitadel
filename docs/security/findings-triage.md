# GitHub Security Findings — Triage Reference

Last updated: 2026-05-18

This document explains how to triage the two recurring categories of GitHub Security findings against this repo and how to fix them **once** without rediscovering the same root cause every time. New AI agents (Claude, Codex, Copilot review bots) and human contributors should read this before opening a PR that touches rate-limit configuration, the secret-scanning allowlist, or the synthetic-token fixtures used by the secret-redaction tests.

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

Do not:

- Bulk-dismiss new `js/missing-rate-limiting` alerts without applying the per-route fix below. Dismissals do not prevent recurrence; the rule will refire on the next new route.
- Broaden `secret_scanning.yml` to cover entire test directories. The current narrow scope is intentional.
- "Rotate", redact, or "clean up" the synthetic Telegram-bot-token-shaped string in the redaction test. It is load-bearing; replacing it with a non-token-shaped placeholder breaks the test's purpose.
- Dismiss a secret-scanning alert with reason `used_in_tests` without first verifying every match in the flagged file is a deliberately-fake placeholder.

---

## 1. CodeQL `js/missing-rate-limiting` on gateway routes

### Why CodeQL keeps flagging these

The gateway registers `@fastify/rate-limit` with `global: false` and uses an `onRoute` hook in [`apps/gateway/src/app.ts`](../../apps/gateway/src/app.ts) (search for `addHook("onRoute"`) to auto-classify every route into a per-IP bucket:

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

`integration-webhooks-shared.ts` exports `createWebhookRouteOptions()`, which provides shared route-options structure (and may include default `config.rateLimit` values). For routes that use this helper, the effective per-route limit should still be set explicitly at registration by spreading the helper output and overriding `config.rateLimit.max` literally at the call site. CodeQL relies on that literal call-site value and may flag routes when the limiter is only implied through a helper:

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

## References

- Implementation: [PR #22 — fix(security): explicit rate-limit configs on gateway routes + test-fixture secret-scan exclusion](https://github.com/goatcitadel/GoatCitadel/pull/22)
- Gateway rate-limit wiring: [`apps/gateway/src/app.ts`](../../apps/gateway/src/app.ts) (search `addHook("onRoute"` and `resolveRateLimitConfig`)
- Helper for webhook route options: [`apps/gateway/src/routes/integration-webhooks-shared.ts`](../../apps/gateway/src/routes/integration-webhooks-shared.ts)
- Top-level policy: [`SECURITY.md`](../../SECURITY.md)
- Agent conventions: [`AGENTS.md`](../../AGENTS.md)
