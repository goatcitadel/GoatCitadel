# Gateway TypeScript 7.1 migration plan

**Goal.** Move Gateway's production Code Mode compiler dependency to stable TypeScript 7.1 while preserving source checks, execution behavior, and approval evidence.

**Scope.** Gateway runtime, its direct TypeScript API tests, and packaged Gateway verification. The root TypeScript 6 API dependency remains available to ESLint and repository scripts during this migration. [Current toolchain contract](../../typescript-7-compiler.md)

## Current Gateway call sites

| Call site | Behavior to preserve |
|---|---|
| `createCodeModeRun` | Trim input as today and validate source before creating a run or approval. |
| Approved-request execution | Validate the supplied source after checking its submitted hash and before verifying the canonical approval binding and registering the run. Preserve the exact source bytes used for hashing. |
| Execution before dispatch | Use the source read from the approved artifact after integrity and policy checks. Transpile TypeScript to ES2022 ESM with comments and without source maps. JavaScript passes through unchanged at this step. Compiler errors stop dispatch. |
| `capability-skill-skip-guard.test.ts` and `channel-probe-wording.test.ts` | Preserve the existing source-inspection assertions. Both files currently resolve `typescript` from Gateway. |

The three production call sites and the compiler helpers live in `apps/gateway/src/services/capability-system-service.ts`. Gateway declares the TS6 API as a production dependency in `apps/gateway/package.json`.

## 1. Establish compiler behavior before changing the dependency

- [ ] Extend the existing `capability-system-service.test.ts` and `capability-system-service.approved-request.test.ts` coverage where gaps exist. Pin the observable outcomes for valid TypeScript and JavaScript, malformed source, existing denied references, and permitted declaration or property-name uses. Include representative inputs that depend on the current TSX parse mode for both languages. Document any mismatch between admission and emit behavior before deciding whether to change it.
- [ ] Assert that source rejected at admission creates no new run or approval. At execution, assert that a compiler failure never calls the backend or records a dispatch boundary. Reuse the existing approval mismatch and artifact hash regressions.
- [x] Save the [TypeScript 6.0.3 approval fixture](../../../apps/gateway/src/services/__fixtures__/code-mode-typescript6-approval.json) from a synthetic Gateway run stopped before dispatch. It preserves the original approval and run records, exact source bytes and hash, wrapper manifest, and policy snapshot. Keep this fixture fixed for the post-switch replay.
- [ ] Record the baseline with focused Gateway tests. Compare verdicts, diagnostic prefixes, dispatch state, and execution results during the port. Emitted JavaScript can differ in formatting while remaining behaviorally equivalent.

## 2. Port the Gateway compiler helpers on stable 7.1

- [ ] Verify the stable package's documented exports for single-source parsing, diagnostics, AST predicates and traversal, and isolated transpilation. The 7.1 examples show `API.createSourceFile` returning a disposable source lease and `API.transpileModule` on the API instance. Use the stable release's export names and types when implementing. [Microsoft's 7.1 beta](https://devblogs.microsoft.com/typescript/announcing-typescript-7-1-beta/) · [TypeScript API tour](https://github.com/DanielRosenwasser/ts7-api-tour/blob/main/typescript-7.1-compiler-api.md)
- [ ] Keep the two service-facing operations, `validateGuestSource(source)` and `transpileGuestSource(language, source)`. Move the compiler-specific implementation into a sibling `code-mode-guest-compiler.ts`. If the async API is used, make both helpers return promises and await them at all three existing call sites before the next state change or dispatch. Prefer async IPC if the stable API supports the required operations, and measure cold and warm calls before choosing the compiler client lifetime.
- [ ] Preserve the current in-memory parse mode, first parse error, traversal order, and distinction between identifier references and declaration or property names. Use explicit visitor ancestry if parent links differ. Keep the current `ValidationError` prefixes and the first transpile error behavior. Confirm isolated emit avoids project and module resolution. Keep compiler startup and communication failures distinguishable from invalid source and fail closed before dispatch. Release leases and shut down compiler clients on their owning lifecycle, including errors. Exercise concurrent validation and compilation with distinct source inputs.
- [ ] Preserve the validation order, exact approved source hash and artifact behavior, and existing execution backend interface. Feed emitted JavaScript to the backend at the existing dispatch path. Re-run the baseline against both compilers before switching the production dependency.

## 3. Switch Gateway's dependency and verify packaged execution

- [ ] Add an exact stable 7.1 production pin in `apps/gateway/package.json` and update `pnpm-lock.yaml`. Prefer a Gateway-local API alias, such as `typescript-gateway`, while root `typescript` still supplies the TS6 tooling API. Confirm `pnpm exec tsc --version` at the root and under the Gateway filter after installation, since the 7.1 package also ships a `tsc` binary.
- [ ] Port the two Gateway test-only AST consumers to the 7.1 API or another existing test helper that preserves their assertions. Exercise both tests and confirm production Gateway no longer imports the legacy API. Update the toolchain documentation. Keep the root toolchain assertion covering the still-supported root compiler and API split.
- [ ] With Gateway's stable 7.1 API installed and wired in, rerun the [saved approval replay test](../../../apps/gateway/src/services/capability-system-service.approved-request.test.ts) from the repository root in PowerShell.

  ```powershell
  & '.\node_modules\.bin\vitest.cmd' run --root apps/gateway src/services/capability-system-service.approved-request.test.ts -t 'resumes the saved TypeScript 6 approval and runs it only once'
  ```

  Expect one passing test. It must resume the original run under the original approval, retain the stored source and artifact bindings, return `{ text: "café", value: 42 }`, and launch the child exactly once across two deliveries of the approval.

- [ ] Run `pnpm --filter @goatcitadel/gateway typecheck`, `pnpm --filter @goatcitadel/gateway test`, `pnpm ts7:toolchain`, `pnpm verify:gateway:async-boundary`, and the applicable `pnpm verify:code-mode:sandbox`, `pnpm verify:code-mode:docker`, and `pnpm verify:cockpit:code-mode` lanes. Verify an approved TypeScript run, a rejected input, and an existing approval resuming successfully. Use disposable profiles and test fixtures.
- [ ] Build the affected Windows installer and Gateway container. In a clean installed or containerized runtime for each affected release target, verify the bundled Node process can load the platform-specific compiler and complete a governed TypeScript run from approval to result. Check compiler startup failure and shutdown in disposable runtime fixtures. Restore the prior Gateway build if a packaged target lacks the compiler or the behavior checks fail. A successful build alone leaves packaged execution unverified.
