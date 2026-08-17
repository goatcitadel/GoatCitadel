# Defensive Patterns

Hard-won bug-class rules for GoatCitadel. Each pattern below is a class of defect that actually shipped (or nearly shipped) in this repository, stated as the rule that prevents its recurrence. Read this before writing lifecycle, concurrency, subprocess, secret-handling, or teardown code.

This is a ratchet: when a shipped bug reveals a new class, add its rule here in the same commit as the fix, with a pointer to the defect. Do not remove rules; superseded rules get a note, not a deletion.

Format inspired by the `docs/defensive-patterns.md` registry in [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT).

## Async state is not synchronous state

A hook or service that flips a flag before an awaited operation and clears it after must account for every exit path — including the ones where the awaited operation never settles or the component unmounts first. A `refreshing`/`loading` flag stranded `true` is a silent hang for every later caller.

Origin: `useDurableBackgroundTaskRail` stranded its `refreshing` flag when `control()` bumped the load sequence mid-flight (2026-08-10 stuck-loading audit). Audit this family by the guarded-clear *shape* (set → await → conditional clear), not by ref names.

## A catch on the call is not a guard on the callee

`value.method().catch(() => fallback)` protects against a rejected promise, not against `value.method` being undefined — that throws synchronously and skips the `.catch`. Guard the method's existence explicitly, or use optional chaining before relying on rejection handling.

Origin: `isVisible` double-fault in the checks lane (2026-07-27); `.catch(() => false)` masked nothing when the method itself was missing.

## Type erasure hides missing awaits

Any seam that erases signatures to `any` (factory indirection, `(...args: any[]) => any` ports) makes `tsc` structurally unable to see a missing `await`. A sync→async service change then silently ships empty response bodies and fail-open gates. Do not add new erasing seams; anything routed through one must be covered by `pnpm verify:gateway:async-boundary`, which rebuilds the erased type information and fails on unawaited route-service promises.

Origin: gateway route-service ports (`route-service-factory.ts`) shipped `{"items":{}}` bodies and a feature-gate that returned 200 instead of 403 (#227 family, guard shipped 2026-08-10).

## Report orthogonal outcomes independently

A result can be several things at once — a process can time out AND exit 0 because it trapped the signal; a stream can be truncated AND redacted. Surface each independent fact (`timedOut`, `exitCode`, `stdoutTruncated`, `redactionCount`) as its own field; never nest one flag's report inside another's branch, or a caller reads a cut-short run as a clean success.

## Dispose must reach quiescence, not just request it

A teardown that issues kills/aborts but returns before the work actually stops leaves orphans that poison later tests and sessions. Make cleanup async and await the children's exit; close listener registries BEFORE killing so late completions stay silent. Test harnesses that never unmount their roots leak real timers into later tests.

Origin: threaded-surface test harness pollution via module-global handle (2026-07-25); leaked test roots' wall-clock timers clobbering later suites (2026-07-29).

## Arm before validate is fail-open

If a guard arms its enforcement after validating input, every invalid input skips enforcement entirely. Arm first, then validate, so a rejection leaves the system guarded. A `Pick<>` or interface narrowing does not narrow the runtime surface — validate the value, not the type.

Origin: heartbeat nullish-admission coverage crash (#216, 2026-07-25).

## A pure read must not mutate state

A GET/list path that repairs, disables, re-audits, or emits events turns every poll into a state change and every dashboard refresh into an incident. Reads take records at face value; verification and repair run only on delivery-shaped paths that already own a write.

Origin: `GET /hooks` re-disabled webhooks, re-appended audit rows, and re-emitted realtime events on every list while the secret store was unreachable (hooks launch defect, fixed in #250).

## Discriminate transient from permanent before destroying state

A failure to reach a dependency is not evidence the referenced state is gone. Only a deliberate permanent signal (the store was reachable and says the item does not exist) may destroy a reference; every transient failure (store locked, disabled, unavailable) must leave the reference intact for retry.

Origin: hook secret custody destroyed `secretRef`s when the OS keychain was merely locked (hooks launch defect, fixed in #250). The discriminator is `isSecretStoreUnavailableLikeError` vs `ValidationError`.

## Never hand a child process the ambient environment

Model-driven spawns (shell, git, test/lint/build runners) receive a scrubbed env — `process.env` minus `SECRET_ENV_KEY_PATTERN` keys (`buildScrubbedSpawnEnv` in `@goatcitadel/contracts`) — so harness and operator credentials cannot leak into tool output, persisted artifacts, or audit rows. `sandbox.spawnEnvPassthrough` is the explicit operator opt-out; results carry `envScrubbed: true`. Fully synthetic envs (Code Mode) remain the stronger posture where workflows allow it.

## Redact before truncating

When output is both scrubbed and bounded, scrub the FULL captured window first, then cut — a secret straddling a truncation boundary must already be masked when the cut lands. The same ordering applies to head+tail retention: redact, then split.

## Audit rows are forever — bound them at write time

Anything persisted per-invocation (audit rows, delivery evidence, run records) must be bounded at the write site, independently of whatever bounds the live path has. Upstream retention limits change; the audit writer cannot assume them.

Origin: raising shell output retention from 4 KiB to 48 KiB would have silently grown `tool_invocations` rows without the audit-projection bound added in the same change.
