# Mission Control Test Bench (Live Console) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dev-only `testbench.html` page in Mission Control Next that runs probes and journeys against an isolated sandbox Gateway (full suite) or the operator's real Gateway (read-only plus confirmed allowlisted checks), and reports honest route coverage against the Gateway's own route list.

**Architecture:** A separate Vite HTML entry (like `chat-demo.html`) injects the `goatcitadel-gateway-origin` meta tag before importing the shared client, so every shared client call goes to the chosen Gateway. A React-free runner (tier policy, error classification, scheduler, immutable reducer) executes a typed catalog of hand-written checks plus auto-probes generated from `GET /api/v1/dev/verification/route-access-manifest`. A `pnpm testbench` launcher boots an isolated stack from shipped defaults with the deterministic LLM stub.

**Tech Stack:** React 19, TypeScript (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), Vite dev server, Vitest 4 with happy-dom, `@goatcitadel/mission-control-shared` API client, Node `node:test` for the launcher, the existing `scripts/verification/lib` stack helpers.

**Spec:** [`docs/superpowers/specs/2026-10-03-mission-control-testbench-live-console-design.md`](../specs/2026-10-03-mission-control-testbench-live-console-design.md)

## Global Constraints

- The page is dev-only. Do not edit `apps/mission-control-next/vite.config.ts` or `apps/mission-control-next/src/main.tsx` (another session has uncommitted work there). The production build has no `rollupOptions.input`, so only `index.html` ships.
- No new dependencies.
- Gateway calls go through `@goatcitadel/mission-control-shared` client functions; use `request()` from `@goatcitadel/mission-control-shared/api/client-core` only for routes without a client function. No raw `fetch`.
- Tier rules (spec section 5.1): `read` runs everywhere; `mutate` only in the verified sandbox; `host` only in the verified sandbox with the per-run opt-in; `external` only after per-check confirmation, and on the real Gateway only when `realSafe`.
- Only `pass` renders as success. Missing evidence is never shown as zero, clean, or healthy.
- CSS: font sizes only `var(--text-*)` with no fallback; never declare `--mc-*` or `--gc-*` properties; `@media` widths only `min-width` 640/1024/1280/1600px or `max-width` 639/1023/1279/1599px.
- Every `<button>` has an explicit `type`. Use `NativeButton` for action buttons; never the raw `mc-next-button` classes.
- No empty `catch` blocks. If a catch intentionally ignores an error, its comment must contain a word such as "best-effort" or "fallback".
- `react-hooks/exhaustive-deps` is an error. Files stay under 400 lines (lint `max-lines` is 1000 and warnings fail CI).
- Tracked files must not contain personal absolute paths (checkout-root or user-profile paths); `pnpm verify:repo:hygiene` rejects them.
- Statuses always pair an icon with a word.
- Windows + PowerShell is the primary shell. Run repo commands from the repository root.
- Do not commit unless the operator explicitly authorized commits for this execution. When authorized, stage files by explicit path only. Never `git stash`.

## Execution Setup

- `main` has another session's uncommitted work. Execute in a separate worktree (superpowers:using-git-worktrees). A worktree on a spinning disk installs slowly; a worktree on an SSD with its own pnpm store is much faster.
- After creating the worktree: `pnpm install`, then `pnpm --filter @goatcitadel/contracts build` (package tests resolve contracts from `dist`).
- Single test file (from the repo root): `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' '<path relative to apps/mission-control-next>'`.

## File Structure

```text
apps/mission-control-next/
  testbench.html                                   # dev-only Vite entry
  src/__testbench__/
    env.ts                                         # reads VITE_GOATCITADEL_TESTBENCH_* + PROD
    main.tsx                                       # PROD guard, meta injection, dynamic import of ui/mount
    main.test.ts
    gateway-target/
      resolve-target.ts                            # ?target= → requested kind + forced origin; meta tag
      resolve-target.test.ts
      detect-target.ts                             # three-part sandbox check → TargetInfo
      detect-target.test.ts
    runner/
      types.ts                                     # CheckDef, CheckContext, RouteKey, tiers
      policy.ts                                    # tier × target permission
      policy.test.ts
      assert.ts                                    # ensure/pass/fail/waitFor/sleep/summarizeEvidence
      assert.test.ts
      classify.ts                                  # ApiRequestError → fail/blocked/cancelled/unreachable
      classify.test.ts
      routes.ts                                    # route keys, manifest, coverage, stale claims
      routes.test.ts
      state.ts                                     # immutable run reducer
      state.test.ts
      scheduler.ts                                 # runChecks: permissions, seeding, pool, abort, timeout
      scheduler.test.ts
      report.ts                                    # Markdown report
      report.test.ts
    catalog/
      dev-verification.ts                          # typed wrappers for /api/v1/dev/verification/*
      dev-verification.test.ts
      domains.ts                                   # area labels
      context.ts                                   # requireWorkspace, createScratchSession, sha256Hex
      auto-probe-exclusions.ts
      auto-probes.ts
      auto-probes.test.ts
      index.ts                                     # HAND_WRITTEN_CHECKS registry
      integrity.test.ts
      health.ts / health.test.ts
      providers.ts / providers.test.ts
      capabilities.ts / capabilities.test.ts
      chat-sessions.ts / chat-sessions.test.ts
      chat-turns.ts / chat-turns.test.ts
      approvals.ts / approvals.test.ts
      memory.ts / memory.test.ts
      durable.ts / durable.test.ts
      backups.ts / backups.test.ts
      realtime.ts / realtime.test.ts
      code-mode.ts / code-mode.test.ts
    test-support/
      context.ts                                   # makeTestContext, findCheck, target fixtures
    ui/
      mount.tsx                                    # CSS imports, theme class, createRoot
      use-testbench.ts                             # load lifecycle + run controller hook
      TestbenchApp.tsx                             # loading/blocked/ready views, tabs, confirm modal
      TopBar.tsx                                   # badge, coverage meter, run controls
      FilterBar.tsx
      AreaRail.tsx
      CheckList.tsx
      CheckDrawer.tsx
      UncoveredRoutes.tsx
      filters.ts                                   # pure filter/summary helpers
      filters.test.ts
      status-display.ts                            # icons, labels, tones, formatting
      status-display.test.ts
      testbench.css
      TestbenchApp.test.tsx
scripts/
  testbench.mjs                                    # launcher
  testbench-runtime.mjs                            # runtime root + child env builders
  testbench-runtime.test.mjs
package.json                                       # + "testbench" script
```

---

### Task 1: Environment reader and target resolution

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/env.ts`
- Create: `apps/mission-control-next/src/__testbench__/gateway-target/resolve-target.ts`
- Test: `apps/mission-control-next/src/__testbench__/gateway-target/resolve-target.test.ts`

**Interfaces:**
- Produces: `TestbenchEnv { sandboxOrigin; sandboxRoot; realOrigin: string | undefined; isProd: boolean }`, `readTestbenchEnv(env?)`, `TargetKind = "sandbox" | "real"`, `TargetRequest { requested: TargetKind; origin: string | undefined }`, `resolveTargetRequest(search, env)`, `GATEWAY_ORIGIN_META_NAME`, `applyGatewayOriginMeta(doc, origin)`, `buildTargetHref(currentHref, kind)`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/gateway-target/resolve-target.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readTestbenchEnv, type TestbenchEnv } from "../env";
import {
  GATEWAY_ORIGIN_META_NAME,
  applyGatewayOriginMeta,
  buildTargetHref,
  resolveTargetRequest,
} from "./resolve-target";

const LAUNCHED: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "/tmp/goatcitadel-usability-testbench",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};

const NOT_LAUNCHED: TestbenchEnv = {
  sandboxOrigin: undefined,
  sandboxRoot: undefined,
  realOrigin: undefined,
  isProd: false,
};

afterEach(() => {
  document.head.innerHTML = "";
});

describe("readTestbenchEnv", () => {
  it("trims launcher values, drops blanks, and reads PROD", () => {
    expect(
      readTestbenchEnv({
        VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: " http://127.0.0.1:41873 ",
        VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: "   ",
        PROD: true,
      }),
    ).toEqual({
      sandboxOrigin: "http://127.0.0.1:41873",
      sandboxRoot: undefined,
      realOrigin: undefined,
      isProd: true,
    });
  });
});

describe("resolveTargetRequest", () => {
  it("defaults to the sandbox when the launcher supplied one", () => {
    expect(resolveTargetRequest("", LAUNCHED)).toEqual({ requested: "sandbox", origin: "http://127.0.0.1:41873" });
  });

  it("defaults to the real gateway and keeps the client's default origin when nothing was launched", () => {
    expect(resolveTargetRequest("", NOT_LAUNCHED)).toEqual({ requested: "real", origin: undefined });
  });

  it("honours an explicit real target with the launcher's real origin", () => {
    expect(resolveTargetRequest("?target=real", LAUNCHED)).toEqual({
      requested: "real",
      origin: "http://127.0.0.1:8787",
    });
  });

  it("keeps an explicit sandbox request even when no sandbox was launched", () => {
    expect(resolveTargetRequest("?target=sandbox", NOT_LAUNCHED)).toEqual({ requested: "sandbox", origin: undefined });
  });

  it("ignores unknown target values", () => {
    expect(resolveTargetRequest("?target=prod", LAUNCHED).requested).toBe("sandbox");
  });
});

describe("applyGatewayOriginMeta", () => {
  it("replaces any existing gateway-origin meta tag", () => {
    applyGatewayOriginMeta(document, "http://127.0.0.1:1111");
    applyGatewayOriginMeta(document, "http://127.0.0.1:2222");
    const tags = document.querySelectorAll(`meta[name="${GATEWAY_ORIGIN_META_NAME}"]`);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.getAttribute("content")).toBe("http://127.0.0.1:2222");
  });

  it("removes the tag when no origin is forced", () => {
    applyGatewayOriginMeta(document, "http://127.0.0.1:1111");
    applyGatewayOriginMeta(document, undefined);
    expect(document.querySelector(`meta[name="${GATEWAY_ORIGIN_META_NAME}"]`)).toBeNull();
  });
});

describe("buildTargetHref", () => {
  it("switches the target and keeps other query parameters", () => {
    expect(buildTargetHref("http://127.0.0.1:5173/testbench.html?target=sandbox&x=1", "real")).toBe(
      "http://127.0.0.1:5173/testbench.html?target=real&x=1",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/gateway-target/resolve-target.test.ts'`
Expected: FAIL, because `../env` and `./resolve-target` do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/env.ts`:

```ts
export interface TestbenchEnv {
  readonly sandboxOrigin: string | undefined;
  readonly sandboxRoot: string | undefined;
  readonly realOrigin: string | undefined;
  readonly isProd: boolean;
}

export function readTestbenchEnv(
  env: Readonly<Record<string, unknown>> = import.meta.env as unknown as Readonly<Record<string, unknown>>,
): TestbenchEnv {
  return {
    sandboxOrigin: readNonEmpty(env.VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN),
    sandboxRoot: readNonEmpty(env.VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT),
    realOrigin: readNonEmpty(env.VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN),
    isProd: env.PROD === true,
  };
}

function readNonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
```

Create `apps/mission-control-next/src/__testbench__/gateway-target/resolve-target.ts`:

```ts
import type { TestbenchEnv } from "../env";

export type TargetKind = "sandbox" | "real";

export interface TargetRequest {
  readonly requested: TargetKind;
  /** Origin forced through the gateway-origin meta tag; undefined keeps the client's default resolution. */
  readonly origin: string | undefined;
}

export const GATEWAY_ORIGIN_META_NAME = "goatcitadel-gateway-origin";

export function resolveTargetRequest(search: string, env: TestbenchEnv): TargetRequest {
  const param = new URLSearchParams(search).get("target");
  const requested: TargetKind =
    param === "sandbox" || param === "real" ? param : env.sandboxOrigin ? "sandbox" : "real";
  return { requested, origin: requested === "sandbox" ? env.sandboxOrigin : env.realOrigin };
}

export function applyGatewayOriginMeta(doc: Document, origin: string | undefined): void {
  for (const existing of Array.from(doc.querySelectorAll(`meta[name="${GATEWAY_ORIGIN_META_NAME}"]`))) {
    existing.remove();
  }
  if (!origin) {
    return;
  }
  const meta = doc.createElement("meta");
  meta.name = GATEWAY_ORIGIN_META_NAME;
  meta.content = origin;
  doc.head.append(meta);
}

export function buildTargetHref(currentHref: string, kind: TargetKind): string {
  const url = new URL(currentHref);
  url.searchParams.set("target", kind);
  return url.toString();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/gateway-target/resolve-target.test.ts'`
Expected: PASS (9 tests).

- [ ] **Step 5: Checkpoint**

Only if the operator authorized commits for this execution:

```powershell
git add apps/mission-control-next/src/__testbench__/env.ts apps/mission-control-next/src/__testbench__/gateway-target/resolve-target.ts apps/mission-control-next/src/__testbench__/gateway-target/resolve-target.test.ts
git commit -m "feat(testbench): resolve the test bench target from the URL"
```

Otherwise leave the files uncommitted and continue.

---

### Task 2: Sandbox detection

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/gateway-target/detect-target.ts`
- Test: `apps/mission-control-next/src/__testbench__/gateway-target/detect-target.test.ts`

**Interfaces:**
- Consumes: `TestbenchEnv` (Task 1), `TargetKind`, `TargetRequest` (Task 1).
- Produces: `DevVerificationStatus { diagnosticsEnabled: boolean; rootDir: string; activeProviderId?; activeModel? }`, `TargetInfo { kind; requested; origin: string; sandboxVerified: boolean; rootDir: string | undefined; reason: string | undefined }`, `DetectTargetDeps { apiBase: string; fetchStatus(): Promise<DevVerificationStatus> }`, `detectTarget(request, env, deps): Promise<TargetInfo>`, `normalizeOrigin(value)`, `normalizeRootPath(value)`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/gateway-target/detect-target.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { TestbenchEnv } from "../env";
import { detectTarget, normalizeRootPath, type DevVerificationStatus } from "./detect-target";

const ENV: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "C:\\Temp\\goatcitadel-usability-x\\",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};

const STATUS: DevVerificationStatus = { diagnosticsEnabled: true, rootDir: "c:/temp/goatcitadel-usability-x" };

function makeDeps(
  apiBase = "http://127.0.0.1:41873/",
  fetchStatus: () => Promise<DevVerificationStatus> = async () => STATUS,
) {
  return { apiBase, fetchStatus: vi.fn(fetchStatus) };
}

describe("detectTarget", () => {
  it("verifies the sandbox when origin and root both match", async () => {
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, makeDeps());
    expect(target).toEqual({
      kind: "sandbox",
      requested: "sandbox",
      origin: "http://127.0.0.1:41873",
      sandboxVerified: true,
      rootDir: STATUS.rootDir,
      reason: undefined,
    });
  });

  it("applies real rules without reading status when the real gateway was requested", async () => {
    const deps = makeDeps("http://127.0.0.1:8787");
    const target = await detectTarget({ requested: "real", origin: ENV.realOrigin }, ENV, deps);
    expect(target).toMatchObject({ kind: "real", requested: "real", sandboxVerified: false, reason: undefined });
    expect(deps.fetchStatus).not.toHaveBeenCalled();
  });

  it("demotes to real rules when no sandbox was launched", async () => {
    const env: TestbenchEnv = { ...ENV, sandboxOrigin: undefined, sandboxRoot: undefined };
    const target = await detectTarget({ requested: "sandbox", origin: undefined }, env, makeDeps());
    expect(target.kind).toBe("real");
    expect(target.reason).toContain("pnpm testbench");
  });

  it("demotes when the gateway is not the launched sandbox", async () => {
    const deps = makeDeps("http://127.0.0.1:8787");
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, deps);
    expect(target.kind).toBe("real");
    expect(target.reason).toContain("is not the launched sandbox");
    expect(deps.fetchStatus).not.toHaveBeenCalled();
  });

  it("demotes when the status endpoint fails", async () => {
    const deps = makeDeps(undefined, async () => {
      throw new Error("API error 404: Development verification endpoints are disabled.");
    });
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, deps);
    expect(target.kind).toBe("real");
    expect(target.reason).toContain("Sandbox status is unavailable: API error 404");
  });

  it("demotes when the gateway root is not the launched root", async () => {
    const deps = makeDeps(undefined, async () => ({ diagnosticsEnabled: true, rootDir: "/elsewhere" }));
    const target = await detectTarget({ requested: "sandbox", origin: ENV.sandboxOrigin }, ENV, deps);
    expect(target).toMatchObject({ kind: "real", sandboxVerified: false, rootDir: "/elsewhere" });
    expect(target.reason).toContain("is not the launched sandbox root");
  });
});

describe("normalizeRootPath", () => {
  it("compares Windows roots without regard to case, slash direction, or a trailing slash", () => {
    expect(normalizeRootPath("C:\\Temp\\X\\")).toBe(normalizeRootPath("c:/temp/x"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/gateway-target/detect-target.test.ts'`
Expected: FAIL, because `./detect-target` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/gateway-target/detect-target.ts`:

```ts
import type { TestbenchEnv } from "../env";
import type { TargetKind, TargetRequest } from "./resolve-target";

export interface DevVerificationStatus {
  readonly diagnosticsEnabled: boolean;
  readonly rootDir: string;
  readonly activeProviderId?: string;
  readonly activeModel?: string;
}

export interface TargetInfo {
  /** Rules applied to checks: "sandbox" only when every sandbox condition held. */
  readonly kind: TargetKind;
  readonly requested: TargetKind;
  readonly origin: string;
  readonly sandboxVerified: boolean;
  readonly rootDir: string | undefined;
  /** Why the sandbox check failed; undefined when verified or when the real gateway was requested. */
  readonly reason: string | undefined;
}

export interface DetectTargetDeps {
  readonly apiBase: string;
  readonly fetchStatus: () => Promise<DevVerificationStatus>;
}

interface TargetBase {
  readonly requested: TargetKind;
  readonly origin: string;
}

export async function detectTarget(
  request: TargetRequest,
  env: TestbenchEnv,
  deps: DetectTargetDeps,
): Promise<TargetInfo> {
  const base: TargetBase = { requested: request.requested, origin: normalizeOrigin(deps.apiBase) };
  if (request.requested !== "sandbox") {
    return { ...base, kind: "real", sandboxVerified: false, rootDir: undefined, reason: undefined };
  }
  if (!env.sandboxOrigin || !env.sandboxRoot) {
    return demoted(base, "No sandbox was launched. Start one with `pnpm testbench`.");
  }
  const expectedOrigin = normalizeOrigin(env.sandboxOrigin);
  if (expectedOrigin !== base.origin) {
    return demoted(base, `Gateway ${base.origin} is not the launched sandbox ${expectedOrigin}.`);
  }
  let status: DevVerificationStatus;
  try {
    status = await deps.fetchStatus();
  } catch (error) {
    return demoted(base, `Sandbox status is unavailable: ${describeError(error)}`);
  }
  if (normalizeRootPath(status.rootDir) !== normalizeRootPath(env.sandboxRoot)) {
    return demoted(base, `Gateway root ${status.rootDir} is not the launched sandbox root.`, status.rootDir);
  }
  return { ...base, kind: "sandbox", sandboxVerified: true, rootDir: status.rootDir, reason: undefined };
}

export function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    // Fallback for values that are not absolute URLs: compare them trimmed.
    return value.trim().replace(/\/+$/, "");
  }
}

export function normalizeRootPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function demoted(base: TargetBase, reason: string, rootDir?: string): TargetInfo {
  return { ...base, kind: "real", sandboxVerified: false, rootDir, reason };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/gateway-target/detect-target.test.ts'`
Expected: PASS (7 tests).

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/gateway-target/detect-target.ts apps/mission-control-next/src/__testbench__/gateway-target/detect-target.test.ts
git commit -m "feat(testbench): verify the sandbox by origin and runtime root"
```

---

### Task 3: Check model and tier policy

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/runner/types.ts`
- Create: `apps/mission-control-next/src/__testbench__/runner/policy.ts`
- Test: `apps/mission-control-next/src/__testbench__/runner/policy.test.ts`

**Interfaces:**
- Consumes: `TargetInfo` (Task 2).
- Produces: `CheckTier`, `HttpMethod`, `RouteKey`, `CheckKind`, `CheckOutcomeStatus`, `CheckResult`, `CheckContext`, `CheckDef`, `RunOptions`, `DEFAULT_CHECK_TIMEOUT_MS`, `Permission`, `checkPermission(check, target, options)`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/runner/policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkPermission } from "./policy";
import type { CheckTier, RunOptions } from "./types";

const NO_OPT_INS: RunOptions = { allowHost: false, confirmedExternalIds: new Set() };
const SANDBOX = { kind: "sandbox" as const };
const REAL = { kind: "real" as const };

function check(tier: CheckTier, realSafe?: true) {
  return { id: `demo.${tier}`, tier, realSafe };
}

describe("checkPermission", () => {
  it("always allows read checks", () => {
    expect(checkPermission(check("read"), SANDBOX, NO_OPT_INS)).toEqual({ allowed: true });
    expect(checkPermission(check("read"), REAL, NO_OPT_INS)).toEqual({ allowed: true });
  });

  it("allows mutate checks only in the verified sandbox", () => {
    expect(checkPermission(check("mutate"), SANDBOX, NO_OPT_INS)).toEqual({ allowed: true });
    expect(checkPermission(check("mutate"), REAL, NO_OPT_INS)).toEqual({
      allowed: false,
      reason: "Mutating checks never run on the real gateway.",
    });
  });

  it("requires the per-run opt-in for host checks and never runs them on the real gateway", () => {
    expect(checkPermission(check("host"), SANDBOX, NO_OPT_INS)).toMatchObject({
      allowed: false,
      reason: expect.stringContaining("Allow host checks"),
    });
    expect(checkPermission(check("host"), SANDBOX, { ...NO_OPT_INS, allowHost: true })).toEqual({ allowed: true });
    expect(checkPermission(check("host"), REAL, { ...NO_OPT_INS, allowHost: true })).toEqual({
      allowed: false,
      reason: "Host checks never run on the real gateway.",
    });
  });

  it("requires confirmation for external checks", () => {
    const confirmed: RunOptions = { allowHost: false, confirmedExternalIds: new Set(["demo.external"]) };
    expect(checkPermission(check("external"), SANDBOX, NO_OPT_INS)).toEqual({
      allowed: false,
      reason: "External checks run only after you confirm them.",
    });
    expect(checkPermission(check("external"), SANDBOX, confirmed)).toEqual({ allowed: true });
  });

  it("runs only realSafe external checks on the real gateway, and only once confirmed", () => {
    const confirmed: RunOptions = { allowHost: false, confirmedExternalIds: new Set(["demo.external"]) };
    expect(checkPermission(check("external"), REAL, confirmed)).toEqual({
      allowed: false,
      reason: "Only allowlisted external checks run on the real gateway.",
    });
    expect(checkPermission(check("external", true), REAL, NO_OPT_INS)).toMatchObject({ allowed: false });
    expect(checkPermission(check("external", true), REAL, confirmed)).toEqual({ allowed: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/policy.test.ts'`
Expected: FAIL, because `./policy` and `./types` do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/runner/types.ts`:

```ts
import type { TargetInfo } from "../gateway-target/detect-target";

export type CheckTier = "read" | "mutate" | "host" | "external";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** Spelled exactly as the Gateway route-access manifest spells it, including `:params`. */
export type RouteKey = `${HttpMethod} /${string}`;
export type CheckKind = "auto" | "probe" | "journey";
export type CheckOutcomeStatus = "pass" | "fail" | "blocked";

export interface CheckResult {
  readonly status: CheckOutcomeStatus;
  readonly summary: string;
  readonly evidence?: unknown;
}

export interface CheckContext {
  readonly target: TargetInfo;
  /** The per-run seeded workspace; present only in the verified sandbox. */
  readonly workspaceId: string | undefined;
  readonly signal: AbortSignal;
  log(message: string, data?: unknown): void;
  step<T>(title: string, run: () => Promise<T>): Promise<T>;
}

export interface CheckDef {
  readonly id: string;
  readonly kind: CheckKind;
  readonly domain: string;
  readonly title: string;
  readonly tier: CheckTier;
  readonly routes: readonly RouteKey[];
  readonly description?: string;
  /** Allowlisted to run on the real gateway once confirmed. Only valid on `external` checks. */
  readonly realSafe?: true;
  /** Needs the per-run seeded workspace, which exists only in the verified sandbox. */
  readonly needsWorkspace?: true;
  /** Declared journey step titles; the drawer shows unreached ones as "not run". */
  readonly steps?: readonly string[];
  readonly timeoutMs?: number;
  run(ctx: CheckContext): Promise<CheckResult>;
}

export interface RunOptions {
  readonly allowHost: boolean;
  readonly confirmedExternalIds: ReadonlySet<string>;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
```

Create `apps/mission-control-next/src/__testbench__/runner/policy.ts`:

```ts
import type { TargetInfo } from "../gateway-target/detect-target";
import type { CheckDef, RunOptions } from "./types";

export type Permission = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

const ALLOWED: Permission = { allowed: true };

export function checkPermission(
  check: Pick<CheckDef, "id" | "tier" | "realSafe">,
  target: Pick<TargetInfo, "kind">,
  options: RunOptions,
): Permission {
  const inSandbox = target.kind === "sandbox";
  switch (check.tier) {
    case "read":
      return ALLOWED;
    case "mutate":
      return inSandbox ? ALLOWED : deny("Mutating checks never run on the real gateway.");
    case "host":
      if (!inSandbox) {
        return deny("Host checks never run on the real gateway.");
      }
      return options.allowHost
        ? ALLOWED
        : deny("Host checks are off for this run. Tick “Allow host checks” to run them.");
    case "external":
      if (!inSandbox && check.realSafe !== true) {
        return deny("Only allowlisted external checks run on the real gateway.");
      }
      return options.confirmedExternalIds.has(check.id)
        ? ALLOWED
        : deny("External checks run only after you confirm them.");
  }
}

function deny(reason: string): Permission {
  return { allowed: false, reason };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/policy.test.ts'`
Expected: PASS (5 tests).

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/runner/types.ts apps/mission-control-next/src/__testbench__/runner/policy.ts apps/mission-control-next/src/__testbench__/runner/policy.test.ts
git commit -m "feat(testbench): add the check model and tier policy"
```

---

### Task 4: Assertions and error classification

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/runner/assert.ts`
- Create: `apps/mission-control-next/src/__testbench__/runner/classify.ts`
- Test: `apps/mission-control-next/src/__testbench__/runner/assert.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/runner/classify.test.ts`

**Interfaces:**
- Consumes: `CheckResult` (Task 3); `ApiRequestError`, `isApiRequestError` from `@goatcitadel/mission-control-shared/api/http-internal` (fields `kind: "http" | "network" | "protocol"`, `method`, `path`, `status?`, `body?`, `bodyText?`).
- Produces: `CheckAssertionError(message, evidence?)`, `ensure(condition, message, evidence?)` (assertion function), `pass(summary, evidence?)`, `fail(summary, evidence?)`, `waitFor(read, done, { signal, timeoutMs, intervalMs?, label })`, `sleep(ms, signal)`, `summarizeEvidence(value, limit?)`, `EVIDENCE_CHAR_LIMIT`; `Classification { status: "fail" | "blocked" | "cancelled" | "unreachable"; summary; evidence? }`, `classifyError(error)`, `readErrorMessage(body, bodyText)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/runner/assert.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CheckAssertionError, ensure, fail, pass, sleep, summarizeEvidence, waitFor } from "./assert";

describe("ensure", () => {
  it("throws a CheckAssertionError that carries the evidence", () => {
    expect(() => ensure(false, "Expected ok.", { ok: false })).toThrow(CheckAssertionError);
    try {
      ensure(0, "Expected a count.", { count: 0 });
    } catch (error) {
      expect(error).toMatchObject({ message: "Expected a count.", evidence: { count: 0 } });
    }
  });

  it("does nothing when the condition holds", () => {
    expect(() => ensure("value", "unused")).not.toThrow();
  });
});

describe("pass and fail", () => {
  it("build results and omit undefined evidence", () => {
    expect(pass("ok")).toEqual({ status: "pass", summary: "ok" });
    expect(fail("bad", { code: 1 })).toEqual({ status: "fail", summary: "bad", evidence: { code: 1 } });
  });
});

describe("waitFor", () => {
  it("resolves with the first value that satisfies the condition", async () => {
    let calls = 0;
    const value = await waitFor(
      async () => {
        calls += 1;
        return calls;
      },
      (count) => count >= 3,
      { signal: new AbortController().signal, timeoutMs: 1_000, intervalMs: 1, label: "Counting" },
    );
    expect(value).toBe(3);
  });

  it("fails with the label and the last value after the timeout", async () => {
    await expect(
      waitFor(async () => "still waiting", () => false, {
        signal: new AbortController().signal,
        timeoutMs: 20,
        intervalMs: 5,
        label: "The approval",
      }),
    ).rejects.toMatchObject({ name: "CheckAssertionError", evidence: "still waiting" });
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const waiting = waitFor(async () => false, (done) => done, {
      signal: controller.signal,
      timeoutMs: 10_000,
      intervalMs: 5,
      label: "Never",
    });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("sleep", () => {
  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("summarizeEvidence", () => {
  it("keeps small values and truncates large ones", () => {
    expect(summarizeEvidence({ ok: true })).toEqual({ ok: true });
    const summarized = summarizeEvidence("x".repeat(50), 10);
    expect(summarized).toBe("xxxxxxxxxx… (40 more characters)");
  });
});
```

Create `apps/mission-control-next/src/__testbench__/runner/classify.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { CheckAssertionError } from "./assert";
import { classifyError, readErrorMessage } from "./classify";

function httpError(status: number, body: unknown) {
  return new ApiRequestError(`API error ${status}`, {
    kind: "http",
    method: "GET",
    path: "/api/v1/demo",
    status,
    body,
    bodyText: JSON.stringify(body),
  });
}

describe("classifyError", () => {
  it("stops the run when the gateway is unreachable", () => {
    const error = new ApiRequestError("Network error GET /api/v1/demo: fetch failed", {
      kind: "network",
      method: "GET",
      path: "/api/v1/demo",
    });
    expect(classifyError(error)).toMatchObject({ status: "unreachable", summary: expect.stringContaining("fetch failed") });
  });

  it("maps a user stop to cancelled and a timeout to fail", () => {
    expect(classifyError(new DOMException("stopped", "AbortError")).status).toBe("cancelled");
    expect(classifyError(new DOMException("slow", "TimeoutError"))).toEqual({
      status: "fail",
      summary: "Timed out before it finished.",
    });
  });

  it("blocks known disabled and unavailable responses", () => {
    expect(classifyError(httpError(404, { error: "Development verification endpoints are disabled." })).status).toBe(
      "blocked",
    );
    expect(
      classifyError(
        httpError(409, {
          error: "Feature flag memoryLifecycleAdminV1Enabled is disabled.",
          code: "STATE_CONFLICT",
          details: { flag: "memoryLifecycleAdminV1Enabled" },
        }),
      ).status,
    ).toBe("blocked");
    expect(classifyError(httpError(400, { error: "Code Mode v1 is disabled. Enable codeModeV1Enabled." })).status).toBe(
      "blocked",
    );
    expect(classifyError(httpError(403, { error: "Authenticated access is required." })).status).toBe("blocked");
    expect(classifyError(httpError(503, { error: "Journey timeline service is unavailable." })).status).toBe("blocked");
  });

  it("fails every other HTTP error with the route and message", () => {
    expect(classifyError(httpError(500, { error: "Internal server error" }))).toMatchObject({
      status: "fail",
      summary: "GET /api/v1/demo returned 500: Internal server error",
    });
    expect(classifyError(httpError(404, { error: "Session not found." })).status).toBe("fail");
  });

  it("fails assertion errors, protocol errors, and plain errors", () => {
    expect(classifyError(new CheckAssertionError("Expected ok.", { ok: false }))).toEqual({
      status: "fail",
      summary: "Expected ok.",
      evidence: { ok: false },
    });
    const protocol = new ApiRequestError("Malformed", {
      kind: "protocol",
      method: "GET",
      path: "/api/v1/demo",
      bodyText: "<html>",
    });
    expect(classifyError(protocol)).toMatchObject({ status: "fail", evidence: "<html>" });
    expect(classifyError(new Error("boom"))).toEqual({ status: "fail", summary: "boom" });
  });
});

describe("readErrorMessage", () => {
  it("reads string errors, coded errors, messages, and raw text", () => {
    expect(readErrorMessage({ error: "Plain." }, undefined)).toBe("Plain.");
    expect(readErrorMessage({ error: { code: "route_changed", reason: "route_decision_required" } }, undefined)).toBe(
      "route_changed: route_decision_required",
    );
    expect(readErrorMessage({ message: "From message." }, undefined)).toBe("From message.");
    expect(readErrorMessage(undefined, " raw text ")).toBe("raw text");
    expect(readErrorMessage(undefined, undefined)).toBe("No error message.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/assert.test.ts' 'src/__testbench__/runner/classify.test.ts'`
Expected: FAIL, because `./assert` and `./classify` do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/runner/assert.ts`:

```ts
import type { CheckResult } from "./types";

export const EVIDENCE_CHAR_LIMIT = 4_000;

export class CheckAssertionError extends Error {
  readonly evidence: unknown;

  constructor(message: string, evidence?: unknown) {
    super(message);
    this.name = "CheckAssertionError";
    this.evidence = evidence;
  }
}

export function ensure(condition: unknown, message: string, evidence?: unknown): asserts condition {
  if (!condition) {
    throw new CheckAssertionError(message, evidence);
  }
}

export function pass(summary: string, evidence?: unknown): CheckResult {
  return evidence === undefined ? { status: "pass", summary } : { status: "pass", summary, evidence };
}

export function fail(summary: string, evidence?: unknown): CheckResult {
  return evidence === undefined ? { status: "fail", summary } : { status: "fail", summary, evidence };
}

export interface WaitForOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
  readonly label: string;
}

export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  options: WaitForOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  const interval = options.intervalMs ?? 500;
  let last = await read();
  while (!done(last)) {
    if (Date.now() >= deadline) {
      throw new CheckAssertionError(
        `${options.label} did not happen within ${Math.max(1, Math.round(options.timeoutMs / 1000))} s.`,
        summarizeEvidence(last),
      );
    }
    await sleep(interval, options.signal);
    last = await read();
  }
  return last;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function summarizeEvidence(value: unknown, limit = EVIDENCE_CHAR_LIMIT): unknown {
  if (value === undefined) {
    return undefined;
  }
  let text: string | undefined;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    // Fallback for values JSON cannot encode (for example cycles): show their string form.
    text = String(value);
  }
  if (text === undefined || text.length <= limit) {
    return value;
  }
  return `${text.slice(0, limit)}… (${text.length - limit} more characters)`;
}
```

Create `apps/mission-control-next/src/__testbench__/runner/classify.ts`:

```ts
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { CheckAssertionError } from "./assert";

export interface Classification {
  readonly status: "fail" | "blocked" | "cancelled" | "unreachable";
  readonly summary: string;
  readonly evidence?: unknown;
}

export function classifyError(error: unknown): Classification {
  if (hasName(error, "AbortError")) {
    return { status: "cancelled", summary: "Stopped before it finished." };
  }
  if (hasName(error, "TimeoutError")) {
    return { status: "fail", summary: "Timed out before it finished." };
  }
  if (error instanceof CheckAssertionError) {
    return { status: "fail", summary: error.message, evidence: error.evidence };
  }
  if (!isApiRequestError(error)) {
    return { status: "fail", summary: error instanceof Error ? error.message : String(error) };
  }
  if (error.kind === "network") {
    return { status: "unreachable", summary: `Gateway unreachable: ${error.message}` };
  }
  if (error.kind === "protocol") {
    return { status: "fail", summary: `Malformed response from ${error.method} ${error.path}.`, evidence: error.bodyText };
  }
  return classifyHttpError(
    error.status ?? 0,
    readErrorMessage(error.body, error.bodyText),
    error.body ?? error.bodyText,
    `${error.method} ${error.path}`,
  );
}

function classifyHttpError(status: number, message: string, evidence: unknown, where: string): Classification {
  const blocked = (summary: string): Classification => ({ status: "blocked", summary, evidence });
  if (status === 404 && /disabled/i.test(message)) {
    return blocked(`Disabled on this gateway: ${message}`);
  }
  if (status === 409 && isFeatureFlagConflict(evidence)) {
    return blocked(`A feature flag is off: ${message}`);
  }
  if (status === 400 && /is disabled/i.test(message)) {
    return blocked(`Disabled on this gateway: ${message}`);
  }
  if (status === 401 || status === 403) {
    return blocked(`Access refused (${status}): ${message}`);
  }
  if (status === 503) {
    return blocked(`Unavailable (503): ${message}`);
  }
  return { status: "fail", summary: `${where} returned ${status}: ${message}`, evidence };
}

export function readErrorMessage(body: unknown, bodyText: string | undefined): string {
  if (isRecord(body)) {
    if (typeof body.error === "string" && body.error.trim() !== "") {
      return body.error;
    }
    if (isRecord(body.error)) {
      const parts = [body.error.code, body.error.reason].filter(
        (part): part is string => typeof part === "string" && part !== "",
      );
      if (parts.length > 0) {
        return parts.join(": ");
      }
    }
    if (typeof body.message === "string" && body.message.trim() !== "") {
      return body.message;
    }
  }
  const text = bodyText?.trim();
  return text ? text : "No error message.";
}

function isFeatureFlagConflict(body: unknown): boolean {
  return isRecord(body) && body.code === "STATE_CONFLICT" && isRecord(body.details) && typeof body.details.flag === "string";
}

function hasName(error: unknown, name: string): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/assert.test.ts' 'src/__testbench__/runner/classify.test.ts'`
Expected: PASS (all tests in both files).

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/runner/assert.ts apps/mission-control-next/src/__testbench__/runner/assert.test.ts apps/mission-control-next/src/__testbench__/runner/classify.ts apps/mission-control-next/src/__testbench__/runner/classify.test.ts
git commit -m "feat(testbench): classify check failures honestly"
```

---

### Task 5: Route keys, coverage, and auto-probes

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/runner/routes.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/auto-probe-exclusions.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/auto-probes.ts`
- Create: `apps/mission-control-next/src/__testbench__/test-support/context.ts`
- Test: `apps/mission-control-next/src/__testbench__/runner/routes.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/auto-probes.test.ts`

**Interfaces:**
- Consumes: `CheckDef`, `CheckContext`, `RouteKey`, `HttpMethod` (Task 3); `pass`, `summarizeEvidence` (Task 4); `TargetKind` (Task 1); `TargetInfo` (Task 2); `request<T>(path, init?)` from `@goatcitadel/mission-control-shared/api/client-core`.
- Produces: `RouteManifestEntry`, `RouteManifest`, `isRouteKey`, `toRouteKey(method, url)`, `splitRouteKey(key)`, `trackedRouteKeys(manifest)`, `domainOfUrl(url)`, `StaleClaim`, `CoverageReport { total; covered; uncovered; staleClaims }`, `computeCoverage(manifestKeys | undefined, checks)`; `AUTO_PROBE_EXCLUSIONS`, `REAL_TARGET_NETWORK_DOMAINS`, `findExclusion(url)`; `buildAutoProbes(manifest, handWritten, targetKind)`; test helpers `SANDBOX_TARGET`, `REAL_TARGET`, `makeTestContext(overrides?)`, `findCheck(checks, id)`.

- [ ] **Step 1: Write the test-support helper**

Create `apps/mission-control-next/src/__testbench__/test-support/context.ts`:

```ts
import type { CheckContext, CheckDef } from "../runner/types";
import type { TargetInfo } from "../gateway-target/detect-target";

export const SANDBOX_TARGET: TargetInfo = {
  kind: "sandbox",
  requested: "sandbox",
  origin: "http://127.0.0.1:41873",
  sandboxVerified: true,
  rootDir: "/tmp/goatcitadel-usability-testbench",
  reason: undefined,
};

export const REAL_TARGET: TargetInfo = {
  kind: "real",
  requested: "real",
  origin: "http://127.0.0.1:8787",
  sandboxVerified: false,
  rootDir: undefined,
  reason: undefined,
};

export interface RecordedStep {
  readonly title: string;
  readonly status: "pass" | "fail";
}

export interface RecordedContext extends CheckContext {
  readonly steps: RecordedStep[];
  readonly messages: string[];
}

export interface TestContextOverrides {
  readonly target?: TargetInfo;
  readonly workspaceId?: string | undefined;
  readonly signal?: AbortSignal;
}

export function makeTestContext(overrides: TestContextOverrides = {}): RecordedContext {
  const steps: RecordedStep[] = [];
  const messages: string[] = [];
  return {
    target: overrides.target ?? SANDBOX_TARGET,
    workspaceId: "workspaceId" in overrides ? overrides.workspaceId : "ws-testbench",
    signal: overrides.signal ?? new AbortController().signal,
    steps,
    messages,
    log(message: string) {
      messages.push(message);
    },
    async step<T>(title: string, run: () => Promise<T>): Promise<T> {
      try {
        const value = await run();
        steps.push({ title, status: "pass" });
        return value;
      } catch (error) {
        steps.push({ title, status: "fail" });
        throw error;
      }
    },
  };
}

export function findCheck(checks: readonly CheckDef[], id: string): CheckDef {
  const found = checks.find((check) => check.id === id);
  if (!found) {
    throw new Error(`No check with id ${id}.`);
  }
  return found;
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/runner/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  computeCoverage,
  domainOfUrl,
  isRouteKey,
  splitRouteKey,
  toRouteKey,
  trackedRouteKeys,
  type RouteManifest,
} from "./routes";

const MANIFEST: RouteManifest = {
  items: [
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "HEAD", url: "/api/v1/workspaces", tracked: true },
    { method: "post", url: "/api/v1/chat/sessions", accessClass: "operator", tracked: true },
    { method: "GET", url: "/health", tracked: false },
  ],
};

describe("route keys", () => {
  it("builds keys only for supported methods", () => {
    expect(toRouteKey("post", "/api/v1/chat/sessions")).toBe("POST /api/v1/chat/sessions");
    expect(toRouteKey("HEAD", "/api/v1/workspaces")).toBeUndefined();
    expect(isRouteKey("GET /api/v1/chat/sessions/:sessionId/status")).toBe(true);
    expect(isRouteKey("GET api/v1/missing-slash")).toBe(false);
    expect(splitRouteKey("PATCH /api/v1/memory/items/:itemId")).toEqual({ method: "PATCH", url: "/api/v1/memory/items/:itemId" });
  });

  it("lists unique tracked keys in order", () => {
    expect(trackedRouteKeys(MANIFEST)).toEqual(["GET /api/v1/workspaces", "POST /api/v1/chat/sessions"]);
  });

  it("derives the area from the URL", () => {
    expect(domainOfUrl("/api/v1/chat/sessions")).toBe("chat");
    expect(domainOfUrl("/health")).toBe("health");
    expect(domainOfUrl("/")).toBe("root");
  });
});

describe("computeCoverage", () => {
  it("reports unavailable coverage when the route list is missing", () => {
    expect(computeCoverage(undefined, [])).toBeUndefined();
  });

  it("counts claimed routes and flags stale /api/v1 claims", () => {
    const report = computeCoverage(trackedRouteKeys(MANIFEST), [
      { id: "chat.lifecycle", routes: ["POST /api/v1/chat/sessions", "POST /api/v1/chat/removed"] },
      { id: "health.gateway", routes: ["GET /health"] },
    ]);
    expect(report).toEqual({
      total: 2,
      covered: 1,
      uncovered: ["GET /api/v1/workspaces"],
      staleClaims: [{ checkId: "chat.lifecycle", route: "POST /api/v1/chat/removed" }],
    });
  });
});
```

Create `apps/mission-control-next/src/__testbench__/catalog/auto-probes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pass } from "../runner/assert";
import type { RouteManifest } from "../runner/routes";
import type { CheckDef } from "../runner/types";
import { makeTestContext } from "../test-support/context";
import { findExclusion } from "./auto-probe-exclusions";
import { buildAutoProbes } from "./auto-probes";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: requestMock }));

const MANIFEST: RouteManifest = {
  items: [
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/workspaces/:workspaceId", accessClass: "operator", tracked: true },
    { method: "POST", url: "/api/v1/workspaces", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/events/feed", accessClass: "sse-read", tracked: true },
    { method: "GET", url: "/api/v1/dev/verification/status", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/llm/config", accessClass: "operator", tracked: true },
    { method: "GET", url: "/api/v1/memory/items", accessClass: "operator", tracked: true },
    { method: "GET", url: "/health", tracked: false },
  ],
};

const CLAIMING: CheckDef = {
  id: "memory.lifecycle",
  kind: "journey",
  domain: "memory",
  title: "Memory lifecycle",
  tier: "mutate",
  routes: ["GET /api/v1/memory/items"],
  run: async () => pass("ok"),
};

beforeEach(() => {
  requestMock.mockReset();
});

describe("buildAutoProbes", () => {
  it("probes unclaimed parameterless GET routes in the sandbox", () => {
    expect(buildAutoProbes(MANIFEST, [CLAIMING], "sandbox").map((probe) => probe.id)).toEqual([
      "auto:GET /api/v1/llm/config",
      "auto:GET /api/v1/workspaces",
    ]);
  });

  it("skips network-reaching areas on the real gateway", () => {
    expect(buildAutoProbes(MANIFEST, [CLAIMING], "real").map((probe) => probe.id)).toEqual(["auto:GET /api/v1/workspaces"]);
  });

  it("generates read probes that pass on a JSON answer", async () => {
    const [probe] = buildAutoProbes(MANIFEST, [CLAIMING], "real");
    expect(probe).toMatchObject({ kind: "auto", tier: "read", domain: "workspaces", title: "workspaces" });
    requestMock.mockResolvedValueOnce({ items: [] });
    const ctx = makeTestContext();
    await expect(probe?.run(ctx)).resolves.toMatchObject({ status: "pass", summary: "Answered with JSON." });
    expect(requestMock).toHaveBeenCalledWith("/api/v1/workspaces", { signal: ctx.signal });
  });

  it("passes a no-content answer", async () => {
    const [probe] = buildAutoProbes(MANIFEST, [CLAIMING], "real");
    requestMock.mockResolvedValueOnce(undefined);
    await expect(probe?.run(makeTestContext())).resolves.toMatchObject({ summary: "Answered with no content." });
  });
});

describe("findExclusion", () => {
  it("excludes documentation, downloads, streams, the remote model catalog, and dev endpoints", () => {
    expect(findExclusion("/api/v1/docs")?.reason).toContain("HTML");
    expect(findExclusion("/api/v1/admin/backups/export")?.reason).toContain("large payload");
    expect(findExclusion("/api/v1/events/stream")?.reason).toContain("Streams");
    expect(findExclusion("/api/v1/llm/models")?.reason).toContain("remote model catalog");
    expect(findExclusion("/api/v1/dev/diagnostics")?.reason).toContain("journeys");
    expect(findExclusion("/api/v1/workspaces")).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/routes.test.ts' 'src/__testbench__/catalog/auto-probes.test.ts'`
Expected: FAIL, because `./routes`, `./auto-probe-exclusions`, and `./auto-probes` do not exist.

- [ ] **Step 4: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/runner/routes.ts`:

```ts
import type { CheckDef, HttpMethod, RouteKey } from "./types";

export interface RouteManifestEntry {
  readonly method: string;
  readonly url: string;
  readonly accessClass?: string;
  readonly classificationSource?: string;
  readonly tracked: boolean;
}

export interface RouteManifest {
  readonly items: readonly RouteManifestEntry[];
}

export interface StaleClaim {
  readonly checkId: string;
  readonly route: RouteKey;
}

export interface CoverageReport {
  readonly total: number;
  readonly covered: number;
  readonly uncovered: readonly RouteKey[];
  readonly staleClaims: readonly StaleClaim[];
}

const HTTP_METHODS: ReadonlySet<string> = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const ROUTE_KEY_PATTERN = /^(GET|POST|PUT|PATCH|DELETE) \/\S*$/;

export function isRouteKey(value: string): value is RouteKey {
  return ROUTE_KEY_PATTERN.test(value);
}

export function toRouteKey(method: string, url: string): RouteKey | undefined {
  const upper = method.toUpperCase();
  if (!HTTP_METHODS.has(upper)) {
    return undefined;
  }
  const key = `${upper} ${url}`;
  return isRouteKey(key) ? key : undefined;
}

export function splitRouteKey(key: RouteKey): { readonly method: HttpMethod; readonly url: string } {
  const space = key.indexOf(" ");
  return { method: key.slice(0, space) as HttpMethod, url: key.slice(space + 1) };
}

export function trackedRouteKeys(manifest: RouteManifest): RouteKey[] {
  const keys = new Set<RouteKey>();
  for (const entry of manifest.items) {
    const key = entry.tracked ? toRouteKey(entry.method, entry.url) : undefined;
    if (key) {
      keys.add(key);
    }
  }
  return [...keys].sort();
}

export function domainOfUrl(url: string): string {
  const segments = url.split("/").filter((segment) => segment !== "");
  if (segments[0] === "api" && segments[1] === "v1") {
    return segments[2] ?? "api";
  }
  return segments[0] ?? "root";
}

export function computeCoverage(
  manifestKeys: readonly RouteKey[] | undefined,
  checks: readonly Pick<CheckDef, "id" | "routes">[],
): CoverageReport | undefined {
  if (!manifestKeys) {
    return undefined;
  }
  const known = new Set(manifestKeys);
  const claimed = new Set<RouteKey>();
  const staleClaims: StaleClaim[] = [];
  for (const check of checks) {
    for (const route of check.routes) {
      if (known.has(route)) {
        claimed.add(route);
      } else if (splitRouteKey(route).url.startsWith("/api/v1/")) {
        staleClaims.push({ checkId: check.id, route });
      }
    }
  }
  return {
    total: manifestKeys.length,
    covered: claimed.size,
    uncovered: manifestKeys.filter((key) => !claimed.has(key)),
    staleClaims,
  };
}
```

Create `apps/mission-control-next/src/__testbench__/catalog/auto-probe-exclusions.ts`:

```ts
export interface AutoProbeExclusion {
  readonly pattern: RegExp;
  readonly reason: string;
}

/** GET routes that must never be auto-probed. Each stays uncovered until a hand-written check claims it. */
export const AUTO_PROBE_EXCLUSIONS: readonly AutoProbeExclusion[] = [
  { pattern: /\/stream(\/|$)/, reason: "Streams events; hand-written realtime checks cover streams." },
  { pattern: /\/(export|download|archive)(\/|$)/, reason: "Downloads a potentially large payload." },
  { pattern: /^\/api\/v1\/docs$/, reason: "Serves the HTML API reference, not JSON." },
  {
    pattern: /^\/api\/v1\/llm\/models$/,
    reason: "Queries the provider's remote model catalog; the external catalog check covers it.",
  },
  { pattern: /^\/api\/v1\/dev\//, reason: "Development verification endpoints are exercised by journeys, not auto-probes." },
];

/** Areas whose reads may reach the network. On the real gateway, auto-probes skip them until reviewed. */
export const REAL_TARGET_NETWORK_DOMAINS: ReadonlySet<string> = new Set([
  "a2a",
  "addons",
  "channels",
  "comms",
  "integrations",
  "llm",
  "mcp",
  "mesh",
  "voice",
]);

export function findExclusion(url: string): AutoProbeExclusion | undefined {
  return AUTO_PROBE_EXCLUSIONS.find((exclusion) => exclusion.pattern.test(url));
}
```

Create `apps/mission-control-next/src/__testbench__/catalog/auto-probes.ts`:

```ts
import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import { pass, summarizeEvidence } from "../runner/assert";
import { domainOfUrl, toRouteKey, type RouteManifest } from "../runner/routes";
import type { CheckDef, RouteKey } from "../runner/types";
import type { TargetKind } from "../gateway-target/resolve-target";
import { REAL_TARGET_NETWORK_DOMAINS, findExclusion } from "./auto-probe-exclusions";

export function buildAutoProbes(
  manifest: RouteManifest,
  handWritten: readonly CheckDef[],
  target: TargetKind,
): CheckDef[] {
  const claimed = new Set(handWritten.flatMap((check) => check.routes));
  const probes = new Map<RouteKey, CheckDef>();
  for (const entry of manifest.items) {
    if (!entry.tracked || entry.method.toUpperCase() !== "GET" || entry.url.includes(":")) {
      continue;
    }
    const key = toRouteKey(entry.method, entry.url);
    const domain = domainOfUrl(entry.url);
    const skipped =
      !key ||
      entry.accessClass === "sse-read" ||
      claimed.has(key) ||
      probes.has(key) ||
      findExclusion(entry.url) !== undefined ||
      (target === "real" && REAL_TARGET_NETWORK_DOMAINS.has(domain));
    if (key && !skipped) {
      probes.set(key, createAutoProbe(key, entry.url, domain));
    }
  }
  return [...probes.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function createAutoProbe(key: RouteKey, url: string, domain: string): CheckDef {
  return {
    id: `auto:${key}`,
    kind: "auto",
    domain,
    title: url.replace(/^\/api\/v1\//, ""),
    tier: "read",
    routes: [key],
    description: "Generated from the route list: the route must answer 2xx with JSON.",
    async run(ctx) {
      const body = await request<unknown>(url, { signal: ctx.signal });
      return body === undefined
        ? pass("Answered with no content.")
        : pass("Answered with JSON.", summarizeEvidence(body));
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/routes.test.ts' 'src/__testbench__/catalog/auto-probes.test.ts'`
Expected: PASS.

- [ ] **Step 6: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/runner/routes.ts apps/mission-control-next/src/__testbench__/runner/routes.test.ts apps/mission-control-next/src/__testbench__/catalog/auto-probe-exclusions.ts apps/mission-control-next/src/__testbench__/catalog/auto-probes.ts apps/mission-control-next/src/__testbench__/catalog/auto-probes.test.ts apps/mission-control-next/src/__testbench__/test-support/context.ts
git commit -m "feat(testbench): measure route coverage and generate read probes"
```

---

### Task 6: Run state reducer

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/runner/state.ts`
- Test: `apps/mission-control-next/src/__testbench__/runner/state.test.ts`

**Interfaces:**
- Produces: `CheckRunStatus = "not-run" | "queued" | "running" | "pass" | "fail" | "blocked" | "skipped" | "cancelled"`, `StepStatus`, `StepRecord`, `CheckLogEntry`, `CheckRecord`, `RunEndReason = "completed" | "stopped" | "unreachable"`, `RunState`, `RunEvent` (union below), `EMPTY_CHECK_RECORD`, `INITIAL_RUN_STATE`, `recordFor(state, id)`, `runReducer(state, event)`, `StatusCounts`, `countStatuses(state, ids)`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/runner/state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INITIAL_RUN_STATE, countStatuses, recordFor, runReducer, type RunEvent, type RunState } from "./state";

function apply(events: readonly RunEvent[], start: RunState = INITIAL_RUN_STATE): RunState {
  return events.reduce(runReducer, start);
}

const AT = "2026-10-03T12:00:00.000Z";

describe("runReducer", () => {
  it("queues checks, records steps and logs, and finishes them without mutating earlier state", () => {
    const started = apply([{ type: "run-started", checkIds: ["a", "b"], at: AT }]);
    const finished = apply(
      [
        { type: "check-started", checkId: "a", at: AT },
        { type: "step-started", checkId: "a", title: "Seed" },
        { type: "step-finished", checkId: "a", title: "Seed", status: "pass" },
        { type: "check-logged", checkId: "a", entry: { at: AT, message: "seeded" } },
        { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 12 },
        { type: "check-skipped", checkId: "b", reason: "Mutating checks never run on the real gateway." },
        { type: "run-finished", at: AT, reason: "completed" },
      ],
      started,
    );
    expect(recordFor(started, "a").status).toBe("queued");
    expect(recordFor(finished, "a")).toEqual({
      status: "pass",
      summary: "ok",
      evidence: undefined,
      durationMs: 12,
      steps: [{ title: "Seed", status: "pass" }],
      log: [{ at: AT, message: "seeded" }],
    });
    expect(recordFor(finished, "b")).toMatchObject({ status: "skipped", summary: expect.stringContaining("real gateway") });
    expect(finished).toMatchObject({ running: false, endReason: "completed", finishedAt: AT });
  });

  it("marks leftover checks cancelled when stopped and not run when the gateway became unreachable", () => {
    const queued = apply([{ type: "run-started", checkIds: ["a", "b"], at: AT }]);
    const stopped = runReducer(queued, { type: "run-finished", at: AT, reason: "stopped" });
    const unreachable = runReducer(queued, {
      type: "run-finished",
      at: AT,
      reason: "unreachable",
      banner: "Gateway unreachable: fetch failed",
    });
    expect(recordFor(stopped, "a").status).toBe("cancelled");
    expect(recordFor(unreachable, "b").status).toBe("not-run");
    expect(unreachable.banner).toBe("Gateway unreachable: fetch failed");
  });

  it("finishes the most recent running step with the same title", () => {
    const state = apply([
      { type: "check-started", checkId: "a", at: AT },
      { type: "step-started", checkId: "a", title: "Poll" },
      { type: "step-finished", checkId: "a", title: "Poll", status: "pass" },
      { type: "step-started", checkId: "a", title: "Poll" },
      { type: "step-finished", checkId: "a", title: "Poll", status: "fail" },
    ]);
    expect(recordFor(state, "a").steps).toEqual([
      { title: "Poll", status: "pass" },
      { title: "Poll", status: "fail" },
    ]);
  });

  it("returns an empty not-run record for unknown checks and counts statuses", () => {
    const state = apply([
      { type: "check-finished", checkId: "a", status: "fail", summary: "bad", durationMs: 1 },
      { type: "check-finished", checkId: "b", status: "blocked", summary: "off", durationMs: 1 },
    ]);
    expect(recordFor(state, "missing").status).toBe("not-run");
    expect(countStatuses(state, ["a", "b", "missing"])).toMatchObject({ fail: 1, blocked: 1, "not-run": 1, pass: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/state.test.ts'`
Expected: FAIL, because `./state` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/runner/state.ts`:

```ts
export type CheckRunStatus = "not-run" | "queued" | "running" | "pass" | "fail" | "blocked" | "skipped" | "cancelled";
export type StepStatus = "running" | "pass" | "fail";
export type RunEndReason = "completed" | "stopped" | "unreachable";

export interface StepRecord {
  readonly title: string;
  readonly status: StepStatus;
}

export interface CheckLogEntry {
  readonly at: string;
  readonly message: string;
  readonly data?: unknown;
}

export interface CheckRecord {
  readonly status: CheckRunStatus;
  readonly summary: string | undefined;
  readonly evidence: unknown;
  readonly durationMs: number | undefined;
  readonly steps: readonly StepRecord[];
  readonly log: readonly CheckLogEntry[];
}

export interface RunState {
  readonly running: boolean;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  readonly endReason: RunEndReason | undefined;
  readonly banner: string | undefined;
  readonly records: Readonly<Record<string, CheckRecord>>;
}

export type RunEvent =
  | { readonly type: "run-started"; readonly checkIds: readonly string[]; readonly at: string }
  | { readonly type: "check-skipped"; readonly checkId: string; readonly reason: string }
  | { readonly type: "check-started"; readonly checkId: string; readonly at: string }
  | { readonly type: "step-started"; readonly checkId: string; readonly title: string }
  | { readonly type: "step-finished"; readonly checkId: string; readonly title: string; readonly status: "pass" | "fail" }
  | { readonly type: "check-logged"; readonly checkId: string; readonly entry: CheckLogEntry }
  | {
      readonly type: "check-finished";
      readonly checkId: string;
      readonly status: "pass" | "fail" | "blocked" | "cancelled";
      readonly summary: string;
      readonly evidence?: unknown;
      readonly durationMs: number;
    }
  | { readonly type: "run-finished"; readonly at: string; readonly reason: RunEndReason; readonly banner?: string };

export type StatusCounts = Readonly<Record<CheckRunStatus, number>>;

export const EMPTY_CHECK_RECORD: CheckRecord = {
  status: "not-run",
  summary: undefined,
  evidence: undefined,
  durationMs: undefined,
  steps: [],
  log: [],
};

export const INITIAL_RUN_STATE: RunState = {
  running: false,
  startedAt: undefined,
  finishedAt: undefined,
  endReason: undefined,
  banner: undefined,
  records: {},
};

export function recordFor(state: RunState, checkId: string): CheckRecord {
  return state.records[checkId] ?? EMPTY_CHECK_RECORD;
}

export function runReducer(state: RunState, event: RunEvent): RunState {
  switch (event.type) {
    case "run-started":
      return startRun(state, event.checkIds, event.at);
    case "check-skipped":
      return updateRecord(state, event.checkId, () => ({ ...EMPTY_CHECK_RECORD, status: "skipped", summary: event.reason }));
    case "check-started":
      return updateRecord(state, event.checkId, () => ({ ...EMPTY_CHECK_RECORD, status: "running" }));
    case "step-started":
      return updateRecord(state, event.checkId, (record) => ({
        ...record,
        steps: [...record.steps, { title: event.title, status: "running" }],
      }));
    case "step-finished":
      return updateRecord(state, event.checkId, (record) => ({
        ...record,
        steps: finishStep(record.steps, event.title, event.status),
      }));
    case "check-logged":
      return updateRecord(state, event.checkId, (record) => ({ ...record, log: [...record.log, event.entry] }));
    case "check-finished":
      return updateRecord(state, event.checkId, (record) => ({
        ...record,
        status: event.status,
        summary: event.summary,
        evidence: event.evidence,
        durationMs: event.durationMs,
      }));
    case "run-finished":
      return finishRun(state, event.at, event.reason, event.banner);
  }
}

export function countStatuses(state: RunState, checkIds: readonly string[]): StatusCounts {
  const counts: Record<CheckRunStatus, number> = {
    "not-run": 0,
    queued: 0,
    running: 0,
    pass: 0,
    fail: 0,
    blocked: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const checkId of checkIds) {
    counts[recordFor(state, checkId).status] += 1;
  }
  return counts;
}

function updateRecord(state: RunState, checkId: string, update: (record: CheckRecord) => CheckRecord): RunState {
  return { ...state, records: { ...state.records, [checkId]: update(recordFor(state, checkId)) } };
}

function startRun(state: RunState, checkIds: readonly string[], at: string): RunState {
  const queued = Object.fromEntries(
    checkIds.map((checkId): [string, CheckRecord] => [checkId, { ...EMPTY_CHECK_RECORD, status: "queued" }]),
  );
  return {
    running: true,
    startedAt: at,
    finishedAt: undefined,
    endReason: undefined,
    banner: undefined,
    records: { ...state.records, ...queued },
  };
}

function finishRun(state: RunState, at: string, reason: RunEndReason, banner: string | undefined): RunState {
  const leftover: CheckRunStatus = reason === "stopped" ? "cancelled" : "not-run";
  const records = Object.fromEntries(
    Object.entries(state.records).map(([checkId, record]): [string, CheckRecord] => [
      checkId,
      record.status === "queued" || record.status === "running" ? { ...record, status: leftover } : record,
    ]),
  );
  return { ...state, running: false, finishedAt: at, endReason: reason, banner, records };
}

function finishStep(steps: readonly StepRecord[], title: string, status: "pass" | "fail"): StepRecord[] {
  let index = -1;
  for (let position = steps.length - 1; position >= 0; position -= 1) {
    const step = steps[position];
    if (step?.title === title && step.status === "running") {
      index = position;
      break;
    }
  }
  return steps.map((step, position) => (position === index ? { ...step, status } : step));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/state.test.ts'`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/runner/state.ts apps/mission-control-next/src/__testbench__/runner/state.test.ts
git commit -m "feat(testbench): add the immutable run reducer"
```

---

### Task 7: Scheduler

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/runner/scheduler.ts`
- Test: `apps/mission-control-next/src/__testbench__/runner/scheduler.test.ts`

**Interfaces:**
- Consumes: `checkPermission` (Task 3), `classifyError` (Task 4), `RunEvent`, `RunEndReason` (Task 6), `CheckDef`, `CheckContext`, `CheckResult`, `RunOptions`, `DEFAULT_CHECK_TIMEOUT_MS` (Task 3), `TargetInfo` (Task 2).
- Produces: `RunSeed { workspaceId: string }`, `RunChecksInput { checks; target; options; signal; emit; seed?; readConcurrency?; now? }`, `DEFAULT_READ_CONCURRENCY = 4`, `runChecks(input): Promise<RunEndReason>`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/runner/scheduler.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { REAL_TARGET, SANDBOX_TARGET } from "../test-support/context";
import { CheckAssertionError, pass } from "./assert";
import { runChecks } from "./scheduler";
import type { RunEvent } from "./state";
import type { CheckDef, CheckResult, CheckTier, RunOptions } from "./types";

const OPTIONS: RunOptions = { allowHost: false, confirmedExternalIds: new Set() };

function makeCheck(
  id: string,
  tier: CheckTier,
  run: CheckDef["run"],
  extra: Omit<Partial<CheckDef>, "id" | "tier" | "run"> = {},
): CheckDef {
  return { id, kind: "probe", domain: "test", title: id, tier, routes: ["GET /api/v1/test"], run, ...extra };
}

function collector() {
  const events: RunEvent[] = [];
  return { events, emit: (event: RunEvent) => void events.push(event) };
}

function finished(events: readonly RunEvent[], checkId: string) {
  return events.find(
    (event): event is Extract<RunEvent, { type: "check-finished" }> =>
      event.type === "check-finished" && event.checkId === checkId,
  );
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("runChecks", () => {
  it("skips disallowed checks with the policy reason and runs the rest", async () => {
    const { events, emit } = collector();
    const reason = await runChecks({
      checks: [makeCheck("r", "read", async () => pass("ok")), makeCheck("m", "mutate", async () => pass("ok"))],
      target: REAL_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(reason).toBe("completed");
    expect(finished(events, "r")).toMatchObject({ status: "pass", summary: "ok" });
    expect(events).toContainEqual({
      type: "check-skipped",
      checkId: "m",
      reason: "Mutating checks never run on the real gateway.",
    });
    expect(events.at(-1)).toMatchObject({ type: "run-finished", reason: "completed" });
  });

  it("runs reads concurrently up to the limit, then mutating checks one at a time", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const tracked = (id: string) => async (): Promise<CheckResult> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      order.push(id);
      return pass(id);
    };
    const reads = Array.from({ length: 5 }, (_, index) => makeCheck(`r${index}`, "read", tracked(`r${index}`)));
    const mutates = [makeCheck("m1", "mutate", tracked("m1")), makeCheck("m2", "mutate", tracked("m2"))];
    await runChecks({
      checks: [...mutates, ...reads],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      readConcurrency: 2,
    });
    expect(peak).toBe(2);
    expect(order.slice(-2)).toEqual(["m1", "m2"]);
  });

  it("records journey steps and classifies thrown assertion failures", async () => {
    const { events, emit } = collector();
    await runChecks({
      checks: [
        makeCheck("j", "read", async (ctx) => {
          await ctx.step("First", async () => undefined);
          ctx.log("halfway");
          await ctx.step("Second", async () => {
            throw new CheckAssertionError("Second failed.", { why: "demo" });
          });
          return pass("unreachable");
        }),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(events.filter((event) => event.type === "step-finished")).toEqual([
      { type: "step-finished", checkId: "j", title: "First", status: "pass" },
      { type: "step-finished", checkId: "j", title: "Second", status: "fail" },
    ]);
    expect(events.some((event) => event.type === "check-logged" && event.entry.message === "halfway")).toBe(true);
    expect(finished(events, "j")).toMatchObject({ status: "fail", summary: "Second failed.", evidence: { why: "demo" } });
  });

  it("stops the run with a banner when the gateway becomes unreachable", async () => {
    const { events, emit } = collector();
    const later = vi.fn(async () => pass("never"));
    const reason = await runChecks({
      checks: [
        makeCheck("m1", "mutate", async () => {
          throw new ApiRequestError("Network error POST /api/v1/test: fetch failed", {
            kind: "network",
            method: "POST",
            path: "/api/v1/test",
          });
        }),
        makeCheck("m2", "mutate", later),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(reason).toBe("unreachable");
    expect(later).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "run-finished",
      reason: "unreachable",
      banner: expect.stringContaining("Gateway unreachable"),
    });
  });

  it("cancels the in-flight check when the operator stops the run", async () => {
    const { events, emit } = collector();
    const controller = new AbortController();
    const started = deferred();
    const running = runChecks({
      checks: [
        makeCheck("m1", "mutate", async () => {
          started.resolve();
          return new Promise<CheckResult>(() => undefined);
        }),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: controller.signal,
      emit,
    });
    await started.promise;
    controller.abort();
    expect(await running).toBe("stopped");
    expect(finished(events, "m1")).toMatchObject({ status: "cancelled" });
  });

  it("fails a check that runs past its timeout", async () => {
    const { events, emit } = collector();
    await runChecks({
      checks: [makeCheck("slow", "read", () => new Promise<CheckResult>(() => undefined), { timeoutMs: 20 })],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
    });
    expect(finished(events, "slow")).toMatchObject({ status: "fail", summary: "Timed out before it finished." });
  });

  it("seeds one workspace for every check that needs it", async () => {
    const seed = vi.fn(async () => ({ workspaceId: "ws-seeded" }));
    const seen: Array<string | undefined> = [];
    const needing = (id: string) =>
      makeCheck(
        id,
        "mutate",
        async (ctx) => {
          seen.push(ctx.workspaceId);
          return pass(id);
        },
        { needsWorkspace: true },
      );
    await runChecks({
      checks: [needing("a"), needing("b")],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      seed,
    });
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["ws-seeded", "ws-seeded"]);
  });

  it("blocks workspace checks when seeding fails and never seeds when nothing needs it", async () => {
    const { events, emit } = collector();
    const failingSeed = vi.fn(async () => {
      throw new CheckAssertionError("seed exploded");
    });
    await runChecks({
      checks: [
        makeCheck("needs", "mutate", async () => pass("never"), { needsWorkspace: true }),
        makeCheck("plain", "mutate", async () => pass("ok")),
      ],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit,
      seed: failingSeed,
    });
    expect(finished(events, "needs")).toMatchObject({
      status: "blocked",
      summary: "Could not seed a test workspace: seed exploded",
    });
    expect(finished(events, "plain")).toMatchObject({ status: "pass" });

    const unusedSeed = vi.fn(async () => ({ workspaceId: "unused" }));
    await runChecks({
      checks: [makeCheck("plain", "read", async () => pass("ok"))],
      target: SANDBOX_TARGET,
      options: OPTIONS,
      signal: new AbortController().signal,
      emit: () => undefined,
      seed: unusedSeed,
    });
    expect(unusedSeed).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/scheduler.test.ts'`
Expected: FAIL, because `./scheduler` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/runner/scheduler.ts`:

```ts
import type { TargetInfo } from "../gateway-target/detect-target";
import { classifyError } from "./classify";
import { checkPermission } from "./policy";
import type { RunEndReason, RunEvent } from "./state";
import { DEFAULT_CHECK_TIMEOUT_MS, type CheckContext, type CheckDef, type RunOptions } from "./types";

export interface RunSeed {
  readonly workspaceId: string;
}

export interface RunChecksInput {
  readonly checks: readonly CheckDef[];
  readonly target: TargetInfo;
  readonly options: RunOptions;
  readonly signal: AbortSignal;
  readonly emit: (event: RunEvent) => void;
  /** Seeds the per-run workspace; called once when an allowed check needs it. */
  readonly seed?: (signal: AbortSignal) => Promise<RunSeed>;
  readonly readConcurrency?: number;
  readonly now?: () => number;
}

interface ExecutionDeps {
  readonly target: TargetInfo;
  readonly workspaceId: string | undefined;
  readonly signal: AbortSignal;
  readonly emit: (event: RunEvent) => void;
  readonly now: () => number;
  readonly onUnreachable: (summary: string) => void;
}

interface PreparedRun {
  readonly runnable: readonly CheckDef[];
  readonly workspaceId: string | undefined;
}

export const DEFAULT_READ_CONCURRENCY = 4;

export async function runChecks(input: RunChecksInput): Promise<RunEndReason> {
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", forwardAbort, { once: true });
  const halt = { unreachable: undefined as string | undefined };
  const onUnreachable = (summary: string) => {
    halt.unreachable ??= summary;
    controller.abort();
  };
  input.emit({ type: "run-started", checkIds: input.checks.map((check) => check.id), at: iso(now()) });
  const prepared = await prepareRun(filterAllowed(input), input, controller.signal, onUnreachable);
  const deps: ExecutionDeps = {
    target: input.target,
    workspaceId: prepared.workspaceId,
    signal: controller.signal,
    emit: input.emit,
    now,
    onUnreachable,
  };
  const reads = prepared.runnable.filter((check) => check.tier === "read");
  const serial = prepared.runnable.filter((check) => check.tier !== "read");
  await runPool(reads, input.readConcurrency ?? DEFAULT_READ_CONCURRENCY, (check) => executeCheck(check, deps), controller.signal);
  for (const check of serial) {
    if (controller.signal.aborted) {
      break;
    }
    await executeCheck(check, deps);
  }
  input.signal.removeEventListener("abort", forwardAbort);
  const reason: RunEndReason =
    halt.unreachable !== undefined ? "unreachable" : input.signal.aborted ? "stopped" : "completed";
  input.emit({ type: "run-finished", at: iso(now()), reason, banner: halt.unreachable });
  return reason;
}

function filterAllowed(input: RunChecksInput): CheckDef[] {
  const allowed: CheckDef[] = [];
  for (const check of input.checks) {
    const permission = checkPermission(check, input.target, input.options);
    if (permission.allowed) {
      allowed.push(check);
    } else {
      input.emit({ type: "check-skipped", checkId: check.id, reason: permission.reason });
    }
  }
  return allowed;
}

async function prepareRun(
  allowed: readonly CheckDef[],
  input: RunChecksInput,
  signal: AbortSignal,
  onUnreachable: (summary: string) => void,
): Promise<PreparedRun> {
  const needing = allowed.filter((check) => check.needsWorkspace === true);
  if (needing.length === 0) {
    return { runnable: allowed, workspaceId: undefined };
  }
  const blockNeeding = (summary: string): PreparedRun => {
    for (const check of needing) {
      input.emit({ type: "check-finished", checkId: check.id, status: "blocked", summary, durationMs: 0 });
    }
    return { runnable: allowed.filter((check) => check.needsWorkspace !== true), workspaceId: undefined };
  };
  if (!input.seed || input.target.kind !== "sandbox") {
    return blockNeeding("No seeded test workspace is available on this target.");
  }
  try {
    const seeded = await input.seed(signal);
    return { runnable: allowed, workspaceId: seeded.workspaceId };
  } catch (error) {
    const classified = classifyError(error);
    if (classified.status === "unreachable") {
      onUnreachable(classified.summary);
    }
    return blockNeeding(`Could not seed a test workspace: ${classified.summary}`);
  }
}

async function executeCheck(check: CheckDef, deps: ExecutionDeps): Promise<void> {
  if (deps.signal.aborted) {
    return;
  }
  const startedAt = deps.now();
  deps.emit({ type: "check-started", checkId: check.id, at: iso(startedAt) });
  const signal = AbortSignal.any([deps.signal, AbortSignal.timeout(check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS)]);
  const finish = (status: "pass" | "fail" | "blocked" | "cancelled", summary: string, evidence?: unknown) =>
    deps.emit({
      type: "check-finished",
      checkId: check.id,
      status,
      summary,
      evidence,
      durationMs: Math.max(0, deps.now() - startedAt),
    });
  try {
    const result = await raceAbort(check.run(createContext(check.id, deps, signal)), signal);
    finish(result.status, result.summary, result.evidence);
  } catch (error) {
    const classified = classifyError(error);
    if (classified.status === "unreachable") {
      deps.onUnreachable(classified.summary);
      finish("fail", classified.summary, classified.evidence);
      return;
    }
    finish(classified.status, classified.summary, classified.evidence);
  }
}

function createContext(checkId: string, deps: ExecutionDeps, signal: AbortSignal): CheckContext {
  return {
    target: deps.target,
    workspaceId: deps.workspaceId,
    signal,
    log(message: string, data?: unknown) {
      deps.emit({ type: "check-logged", checkId, entry: { at: iso(deps.now()), message, data } });
    },
    async step<T>(title: string, run: () => Promise<T>): Promise<T> {
      deps.emit({ type: "step-started", checkId, title });
      try {
        const value = await run();
        deps.emit({ type: "step-finished", checkId, title, status: "pass" });
        return value;
      } catch (error) {
        deps.emit({ type: "step-finished", checkId, title, status: "fail" });
        throw error;
      }
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!signal.aborted) {
      const item = items[next];
      next += 1;
      if (item === undefined) {
        return;
      }
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/scheduler.test.ts'`
Expected: PASS (8 tests).

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/runner/scheduler.ts apps/mission-control-next/src/__testbench__/runner/scheduler.test.ts
git commit -m "feat(testbench): schedule checks with tiers, seeding, stop, and timeouts"
```

---

### Task 8: Report, filters, and status display helpers

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/runner/report.ts`
- Create: `apps/mission-control-next/src/__testbench__/ui/filters.ts`
- Create: `apps/mission-control-next/src/__testbench__/ui/status-display.ts`
- Test: `apps/mission-control-next/src/__testbench__/runner/report.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/ui/filters.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/ui/status-display.test.ts`

**Interfaces:**
- Consumes: `RunState`, `recordFor`, `countStatuses`, `StatusCounts`, `CheckRunStatus`, `StepStatus` (Task 6); `CoverageReport`, `domainOfUrl`, `splitRouteKey` (Task 5); `CheckDef`, `CheckTier`, `RouteKey` (Task 3); `TargetInfo` (Task 2).
- Produces: `ReportInput`, `buildMarkdownReport(input)`, `describeTarget(target)`, `describeCoverage(coverage)`; `StatusFilter`, `CheckFilters`, `DEFAULT_FILTERS`, `filterChecks(checks, state, filters)`, `countForFilter(counts, filter)`, `toggleTier(tiers, tier)`, `DomainSummary`, `summarizeDomains(checks, state, labelFor)`, `groupRoutesByDomain(routes)`; `StatusTone`, `StatusDisplay`, `STATUS_DISPLAY`, `STEP_ICON`, `KIND_LABELS`, `formatDuration(ms)`, `formatEvidence(value)`, `describeRunEnd(state, counts)`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/runner/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { REAL_TARGET, SANDBOX_TARGET } from "../test-support/context";
import { pass } from "./assert";
import { buildMarkdownReport, describeCoverage, describeTarget } from "./report";
import { INITIAL_RUN_STATE, runReducer, type RunEvent } from "./state";
import type { CheckDef } from "./types";

const CHECKS: CheckDef[] = [
  { id: "a", kind: "probe", domain: "chat", title: "Chat | sessions", tier: "read", routes: ["GET /api/v1/a"], run: async () => pass("ok") },
  { id: "b", kind: "probe", domain: "memory", title: "Memory", tier: "mutate", routes: ["GET /api/v1/b"], run: async () => pass("ok") },
];

const EVENTS: RunEvent[] = [
  { type: "check-finished", checkId: "a", status: "fail", summary: "Broke\nhere | badly", durationMs: 3 },
  { type: "check-finished", checkId: "b", status: "pass", summary: "ok", durationMs: 3 },
];

describe("buildMarkdownReport", () => {
  it("summarizes the target, coverage, counts, and failing checks", () => {
    const state = EVENTS.reduce(runReducer, INITIAL_RUN_STATE);
    const markdown = buildMarkdownReport({
      target: SANDBOX_TARGET,
      coverage: { total: 4, covered: 1, uncovered: [], staleClaims: [] },
      checks: CHECKS,
      state,
      generatedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(markdown).toContain("# GoatCitadel test bench report");
    expect(markdown).toContain("- Coverage: 1 / 4 routes (25%)");
    expect(markdown).toContain("- Results: 1 pass, 1 fail, 0 blocked, 0 skipped, 0 cancelled, 0 not run");
    expect(markdown).toContain("| fail | chat | Chat \\| sessions | Broke here \\| badly |");
  });

  it("omits the problem table when nothing failed", () => {
    const markdown = buildMarkdownReport({
      target: REAL_TARGET,
      coverage: undefined,
      checks: CHECKS,
      state: INITIAL_RUN_STATE,
      generatedAt: "2026-10-03T12:00:00.000Z",
    });
    expect(markdown).not.toContain("## Failing and blocked");
    expect(markdown).toContain("unavailable");
  });
});

describe("describeTarget and describeCoverage", () => {
  it("names the sandbox root and any failed sandbox condition", () => {
    expect(describeTarget(SANDBOX_TARGET)).toContain("root /tmp/goatcitadel-usability-testbench");
    expect(describeTarget({ ...REAL_TARGET, reason: "No sandbox was launched." })).toContain("sandbox check failed");
    expect(describeCoverage({ total: 0, covered: 0, uncovered: [], staleClaims: [] })).toBe("0 / 0 routes (0%)");
  });
});
```

Create `apps/mission-control-next/src/__testbench__/ui/filters.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { pass } from "../runner/assert";
import { INITIAL_RUN_STATE, countStatuses, runReducer, type RunEvent } from "../runner/state";
import type { CheckDef } from "../runner/types";
import {
  DEFAULT_FILTERS,
  countForFilter,
  filterChecks,
  groupRoutesByDomain,
  summarizeDomains,
  toggleTier,
} from "./filters";

const CHECKS: CheckDef[] = [
  { id: "a", kind: "probe", domain: "chat", title: "Session lifecycle", tier: "mutate", routes: ["POST /api/v1/chat/sessions"], run: async () => pass("ok") },
  { id: "b", kind: "auto", domain: "memory", title: "memory/items", tier: "read", routes: ["GET /api/v1/memory/items"], run: async () => pass("ok") },
  { id: "c", kind: "probe", domain: "chat", title: "Cancel turn", tier: "mutate", routes: ["POST /api/v1/chat/sessions/:sessionId/turns/:turnId/cancel"], run: async () => pass("ok") },
];

const EVENTS: RunEvent[] = [
  { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 1 },
  { type: "check-finished", checkId: "c", status: "fail", summary: "bad", durationMs: 1 },
];

const STATE = EVENTS.reduce(runReducer, INITIAL_RUN_STATE);

describe("filterChecks", () => {
  it("filters by area, tier, status, and search text across titles and routes", () => {
    expect(filterChecks(CHECKS, STATE, DEFAULT_FILTERS).map((check) => check.id)).toEqual(["a", "b", "c"]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, domain: "chat" }).map((check) => check.id)).toEqual(["a", "c"]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, tiers: new Set(["read"]) }).map((check) => check.id)).toEqual(["b"]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, status: "failing" }).map((check) => check.id)).toEqual(["c"]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, status: "not-run" }).map((check) => check.id)).toEqual(["b"]);
    expect(filterChecks(CHECKS, STATE, { ...DEFAULT_FILTERS, query: "/CANCEL" }).map((check) => check.id)).toEqual(["c"]);
  });
});

describe("filter helpers", () => {
  it("counts filter matches, toggles tiers immutably, and summarizes areas", () => {
    const counts = countStatuses(STATE, CHECKS.map((check) => check.id));
    expect(countForFilter(counts, "failing")).toBe(1);
    expect(countForFilter(counts, "not-run")).toBe(1);
    const original = new Set<"read">(["read"]);
    expect([...toggleTier(original, "read")]).toEqual([]);
    expect([...original]).toEqual(["read"]);
    expect(summarizeDomains(CHECKS, STATE, (domain) => domain.toUpperCase())).toEqual([
      { domain: "chat", label: "CHAT", total: 2, passed: 1, failing: 1 },
      { domain: "memory", label: "MEMORY", total: 1, passed: 0, failing: 0 },
    ]);
  });

  it("groups uncovered routes by area", () => {
    expect(groupRoutesByDomain(["GET /api/v1/memory/items", "POST /api/v1/chat/sessions", "GET /api/v1/chat/sessions"])).toEqual([
      ["chat", ["POST /api/v1/chat/sessions", "GET /api/v1/chat/sessions"]],
      ["memory", ["GET /api/v1/memory/items"]],
    ]);
  });
});
```

Create `apps/mission-control-next/src/__testbench__/ui/status-display.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INITIAL_RUN_STATE, countStatuses, runReducer, type RunEvent } from "../runner/state";
import { STATUS_DISPLAY, describeRunEnd, formatDuration, formatEvidence } from "./status-display";

describe("status display", () => {
  it("pairs every status with an icon and a word", () => {
    for (const display of Object.values(STATUS_DISPLAY)) {
      expect(display.icon).not.toBe("");
      expect(display.label).toMatch(/^[a-z ]+$/);
    }
    expect(STATUS_DISPLAY.pass).toEqual({ icon: "✓", label: "pass", tone: "success" });
  });

  it("formats durations and evidence", () => {
    expect(formatDuration(41)).toBe("41 ms");
    expect(formatDuration(2_400)).toBe("2.4 s");
    expect(formatEvidence("raw")).toBe("raw");
    expect(formatEvidence({ ok: true })).toBe('{\n  "ok": true\n}');
  });

  it("announces a finished run once, and nothing while running", () => {
    const running = runReducer(INITIAL_RUN_STATE, { type: "run-started", checkIds: ["a"], at: "t" });
    expect(describeRunEnd(running, countStatuses(running, ["a"]))).toBe("");
    const finishing: RunEvent[] = [
      { type: "check-finished", checkId: "a", status: "pass", summary: "ok", durationMs: 1 },
      { type: "run-finished", at: "t", reason: "completed" },
    ];
    const done = finishing.reduce(runReducer, running);
    expect(describeRunEnd(done, countStatuses(done, ["a"]))).toBe(
      "Run completed: 1 pass, 0 fail, 0 blocked, 0 skipped.",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/report.test.ts' 'src/__testbench__/ui/filters.test.ts' 'src/__testbench__/ui/status-display.test.ts'`
Expected: FAIL, because the three modules do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/runner/report.ts`:

```ts
import type { TargetInfo } from "../gateway-target/detect-target";
import type { CoverageReport } from "./routes";
import { countStatuses, recordFor, type RunState } from "./state";
import type { CheckDef } from "./types";

export interface ReportInput {
  readonly target: TargetInfo;
  readonly coverage: CoverageReport | undefined;
  readonly checks: readonly CheckDef[];
  readonly state: RunState;
  readonly generatedAt: string;
}

export function buildMarkdownReport(input: ReportInput): string {
  const counts = countStatuses(input.state, input.checks.map((check) => check.id));
  const header = [
    "# GoatCitadel test bench report",
    "",
    `- Generated: ${input.generatedAt}`,
    `- Target: ${describeTarget(input.target)}`,
    `- Coverage: ${describeCoverage(input.coverage)}`,
    `- Results: ${counts.pass} pass, ${counts.fail} fail, ${counts.blocked} blocked, ${counts.skipped} skipped, ${counts.cancelled} cancelled, ${counts["not-run"]} not run`,
  ];
  const problems = input.checks.filter((check) => {
    const status = recordFor(input.state, check.id).status;
    return status === "fail" || status === "blocked";
  });
  if (problems.length === 0) {
    return `${header.join("\n")}\n`;
  }
  const rows = problems.map((check) => {
    const record = recordFor(input.state, check.id);
    return `| ${record.status} | ${check.domain} | ${escapeCell(check.title)} | ${escapeCell(record.summary ?? "")} |`;
  });
  return `${[...header, "", "## Failing and blocked", "", "| Status | Area | Check | Summary |", "| --- | --- | --- | --- |", ...rows].join("\n")}\n`;
}

export function describeTarget(target: TargetInfo): string {
  if (target.kind === "sandbox") {
    return `sandbox ${target.origin} (root ${target.rootDir ?? "unknown"})`;
  }
  return target.reason
    ? `real gateway ${target.origin} (sandbox check failed: ${target.reason})`
    : `real gateway ${target.origin}`;
}

export function describeCoverage(coverage: CoverageReport | undefined): string {
  if (!coverage) {
    return "unavailable (the gateway did not serve its route list)";
  }
  const percent = coverage.total === 0 ? 0 : Math.round((coverage.covered / coverage.total) * 100);
  return `${coverage.covered} / ${coverage.total} routes (${percent}%)`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}
```

Create `apps/mission-control-next/src/__testbench__/ui/filters.ts`:

```ts
import { domainOfUrl, splitRouteKey } from "../runner/routes";
import { recordFor, type CheckRunStatus, type RunState, type StatusCounts } from "../runner/state";
import type { CheckDef, CheckTier, RouteKey } from "../runner/types";

export type StatusFilter = "all" | "failing" | "blocked" | "skipped" | "not-run";

export interface CheckFilters {
  readonly status: StatusFilter;
  readonly tiers: ReadonlySet<CheckTier>;
  readonly query: string;
  readonly domain: string | undefined;
}

export interface DomainSummary {
  readonly domain: string;
  readonly label: string;
  readonly total: number;
  readonly passed: number;
  readonly failing: number;
}

export const DEFAULT_FILTERS: CheckFilters = { status: "all", tiers: new Set<CheckTier>(), query: "", domain: undefined };

const STATUS_FILTER_MATCHES: Readonly<Record<Exclude<StatusFilter, "all">, readonly CheckRunStatus[]>> = {
  failing: ["fail"],
  blocked: ["blocked"],
  skipped: ["skipped"],
  "not-run": ["not-run", "cancelled"],
};

export function filterChecks(checks: readonly CheckDef[], state: RunState, filters: CheckFilters): CheckDef[] {
  const query = filters.query.trim().toLowerCase();
  return checks.filter((check) => {
    if (filters.domain !== undefined && check.domain !== filters.domain) {
      return false;
    }
    if (filters.tiers.size > 0 && !filters.tiers.has(check.tier)) {
      return false;
    }
    if (filters.status !== "all" && !STATUS_FILTER_MATCHES[filters.status].includes(recordFor(state, check.id).status)) {
      return false;
    }
    return (
      query === "" ||
      check.title.toLowerCase().includes(query) ||
      check.routes.some((route) => route.toLowerCase().includes(query))
    );
  });
}

export function countForFilter(counts: StatusCounts, filter: Exclude<StatusFilter, "all">): number {
  return STATUS_FILTER_MATCHES[filter].reduce((sum, status) => sum + counts[status], 0);
}

export function toggleTier(tiers: ReadonlySet<CheckTier>, tier: CheckTier): ReadonlySet<CheckTier> {
  return tiers.has(tier) ? new Set([...tiers].filter((existing) => existing !== tier)) : new Set([...tiers, tier]);
}

export function summarizeDomains(
  checks: readonly CheckDef[],
  state: RunState,
  labelFor: (domain: string) => string,
): DomainSummary[] {
  const byDomain = new Map<string, readonly CheckDef[]>();
  for (const check of checks) {
    byDomain.set(check.domain, [...(byDomain.get(check.domain) ?? []), check]);
  }
  return [...byDomain.entries()]
    .map(([domain, list]) => ({
      domain,
      label: labelFor(domain),
      total: list.length,
      passed: list.filter((check) => recordFor(state, check.id).status === "pass").length,
      failing: list.filter((check) => recordFor(state, check.id).status === "fail").length,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function groupRoutesByDomain(routes: readonly RouteKey[]): Array<readonly [string, readonly RouteKey[]]> {
  const groups = new Map<string, readonly RouteKey[]>();
  for (const route of routes) {
    const domain = domainOfUrl(splitRouteKey(route).url);
    groups.set(domain, [...(groups.get(domain) ?? []), route]);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}
```

Create `apps/mission-control-next/src/__testbench__/ui/status-display.ts`:

```ts
import type { CheckRunStatus, RunState, StatusCounts, StepStatus } from "../runner/state";
import type { CheckKind } from "../runner/types";

export type StatusTone = "success" | "warning" | "critical" | "muted" | "neutral" | "live";

export interface StatusDisplay {
  readonly icon: string;
  readonly label: string;
  readonly tone: StatusTone;
}

export const STATUS_DISPLAY: Readonly<Record<CheckRunStatus, StatusDisplay>> = {
  "not-run": { icon: "○", label: "not run", tone: "neutral" },
  queued: { icon: "…", label: "queued", tone: "muted" },
  running: { icon: "◌", label: "running", tone: "live" },
  pass: { icon: "✓", label: "pass", tone: "success" },
  fail: { icon: "✕", label: "fail", tone: "critical" },
  blocked: { icon: "◐", label: "blocked", tone: "warning" },
  skipped: { icon: "–", label: "skipped", tone: "muted" },
  cancelled: { icon: "■", label: "cancelled", tone: "muted" },
};

export const STEP_ICON: Readonly<Record<StepStatus, string>> = { running: "◌", pass: "✓", fail: "✕" };

export const KIND_LABELS: Readonly<Record<CheckKind, string>> = { auto: "auto", probe: "probe", journey: "journey" };

export function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

export function formatEvidence(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Fallback for values JSON cannot encode: show their string form.
    return String(value);
  }
}

export function describeRunEnd(state: RunState, counts: StatusCounts): string {
  if (state.running || state.endReason === undefined) {
    return "";
  }
  return `Run ${state.endReason}: ${counts.pass} pass, ${counts.fail} fail, ${counts.blocked} blocked, ${counts.skipped} skipped.`;
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/runner/report.test.ts' 'src/__testbench__/ui/filters.test.ts' 'src/__testbench__/ui/status-display.test.ts'`
Expected: PASS.

Run: `pnpm --filter @goatcitadel/mission-control-next typecheck`
Expected: exit code 0.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/runner/report.ts apps/mission-control-next/src/__testbench__/runner/report.test.ts apps/mission-control-next/src/__testbench__/ui/filters.ts apps/mission-control-next/src/__testbench__/ui/filters.test.ts apps/mission-control-next/src/__testbench__/ui/status-display.ts apps/mission-control-next/src/__testbench__/ui/status-display.test.ts
git commit -m "feat(testbench): add report, filter, and status display helpers"
```

---

### Task 9: Catalog foundation: dev verification client, area labels, health checks, integrity test

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/catalog/dev-verification.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/domains.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/health.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/index.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/dev-verification.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/health.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/integrity.test.ts`

**Interfaces:**
- Consumes: `request<T>(path, init?)` from `@goatcitadel/mission-control-shared/api/client-core`; `isApiRequestError` from `.../api/http-internal`; `ensure`, `pass`, `fail` (Task 4); `CheckDef` (Task 3); `RouteManifest`, `isRouteKey`, `splitRouteKey` (Task 5); `DevVerificationStatus` (Task 2); `makeTestContext`, `findCheck` (Task 5).
- Produces: `fetchDevStatus()`, `fetchRouteManifest()`, `seedWorkspace(label)` → `SeededWorkspace { workspaceId; sessionId; sessionIds }`, `seedChatApprovalScenario(scope)` → `ChatApprovalScenario { sessionId; workspaceId; turnId; userMessageId; approvalId; approvalWaitRunId; chatTurnDurableRunId }`, `seedChatUserInputScenario(scope)` → `ChatUserInputScenario { sessionId; workspaceId; turnId; userMessageId; promptId; chatTurnDurableRunId }`, `seedMemoryItem(input)` → `SeededMemoryItem`, `seedDurableRecovery()` → `DurableRecoverySeed`, `exerciseProvider({ scenario: "simple" })` → `ProviderExerciseResult`, `SessionScope { sessionId; workspaceId }`; `DOMAIN_LABELS`, `domainLabel(domain)`; `healthChecks`; `HAND_WRITTEN_CHECKS`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/catalog/dev-verification.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  exerciseProvider,
  fetchDevStatus,
  fetchRouteManifest,
  seedChatApprovalScenario,
  seedChatUserInputScenario,
  seedDurableRecovery,
  seedMemoryItem,
  seedWorkspace,
} from "./dev-verification";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: requestMock }));

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({});
});

function lastPost() {
  const [path, init] = requestMock.mock.calls.at(-1) ?? [];
  return { path, method: (init as RequestInit | undefined)?.method, body: JSON.parse(String((init as RequestInit).body)) };
}

describe("dev verification client", () => {
  it("reads status and the route list", async () => {
    await fetchDevStatus();
    await fetchRouteManifest();
    expect(requestMock.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/dev/verification/status",
      "/api/v1/dev/verification/route-access-manifest",
    ]);
  });

  it("seeds a one-session workspace", async () => {
    await seedWorkspace("Test bench run");
    expect(lastPost()).toEqual({
      path: "/api/v1/dev/verification/seed",
      method: "POST",
      body: { workspaceName: "Test bench run", sessionTitle: "Test bench run session", sessionCount: 1, longThreadTurns: 2 },
    });
  });

  it("posts each scenario seed to its route", async () => {
    const scope = { sessionId: "s-1", workspaceId: "ws-1" };
    await seedChatApprovalScenario(scope);
    expect(lastPost()).toMatchObject({ path: "/api/v1/dev/verification/chat-approval-scenario", body: scope });
    await seedChatUserInputScenario(scope);
    expect(lastPost()).toMatchObject({ path: "/api/v1/dev/verification/chat-user-input-scenario", body: scope });
    await seedMemoryItem({ workspaceId: "ws-1", namespace: "testbench", title: "Note", content: "Body" });
    expect(lastPost()).toMatchObject({ path: "/api/v1/dev/verification/memory-item-seed", body: { namespace: "testbench" } });
    await exerciseProvider({ scenario: "simple" });
    expect(lastPost()).toMatchObject({ path: "/api/v1/dev/verification/provider-exercise", body: { scenario: "simple" } });
  });

  it("sends an empty JSON object to the body-less durable recovery seed", async () => {
    await seedDurableRecovery();
    expect(lastPost()).toEqual({ path: "/api/v1/dev/verification/durable-recovery-seed", method: "POST", body: {} });
  });
});
```

Create `apps/mission-control-next/src/__testbench__/catalog/health.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { findCheck, makeTestContext } from "../test-support/context";
import { healthChecks } from "./health";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: requestMock }));

beforeEach(() => {
  requestMock.mockReset();
});

describe("health checks", () => {
  it("passes when the gateway reports ok", async () => {
    requestMock.mockResolvedValueOnce({ status: "ok", readiness: "ready", service: "gateway" });
    const ctx = makeTestContext();
    await expect(findCheck(healthChecks, "health.gateway").run(ctx)).resolves.toMatchObject({ status: "pass" });
    expect(requestMock).toHaveBeenCalledWith("/health", { signal: ctx.signal });
  });

  it("fails, rather than blocks, when health answers 503 degraded", async () => {
    requestMock.mockRejectedValueOnce(
      new ApiRequestError("API error 503", {
        kind: "http",
        method: "GET",
        path: "/health",
        status: 503,
        body: { status: "degraded", readiness: "degraded", service: "gateway" },
      }),
    );
    await expect(findCheck(healthChecks, "health.gateway").run(makeTestContext())).resolves.toMatchObject({
      status: "fail",
      summary: expect.stringContaining("degraded"),
    });
  });

  it("requires liveness to report uptime", async () => {
    requestMock.mockResolvedValueOnce({ status: "ok", service: "gateway", uptimeSeconds: 42.4 });
    await expect(findCheck(healthChecks, "health.livez").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Process alive for 42 s.",
    });
    requestMock.mockResolvedValueOnce({ status: "ok", service: "gateway" });
    await expect(findCheck(healthChecks, "health.livez").run(makeTestContext())).rejects.toThrow("did not report uptime");
  });

  it("names the readiness checks that are not ready", async () => {
    requestMock.mockResolvedValueOnce({
      status: "ok",
      readiness: "ready",
      service: "gateway",
      checks: [
        { key: "database", state: "ready" },
        { key: "config_generation", state: "degraded" },
      ],
    });
    await expect(findCheck(healthChecks, "ops.readiness").run(makeTestContext())).resolves.toMatchObject({
      status: "fail",
      summary: "Readiness is degraded: config_generation.",
    });
  });
});
```

Create `apps/mission-control-next/src/__testbench__/catalog/integrity.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isRouteKey, splitRouteKey } from "../runner/routes";
import { DOMAIN_LABELS, domainLabel } from "./domains";
import { HAND_WRITTEN_CHECKS } from "./index";

const HOST_ROUTE_PATTERNS: readonly RegExp[] = [/^POST \/api\/v1\/code-mode\//, /^POST \/api\/v1\/chat\/tools\/approve$/];

describe("hand-written catalog integrity", () => {
  it("uses unique ids", () => {
    const ids = HAND_WRITTEN_CHECKS.map((check) => check.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares at least one well-formed route per check", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      expect(check.routes.length, check.id).toBeGreaterThan(0);
      for (const route of check.routes) {
        expect(isRouteKey(route), `${check.id}: ${route}`).toBe(true);
      }
    }
  });

  it("never tiers a check that claims a non-GET route as read", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      if (check.routes.some((route) => splitRouteKey(route).method !== "GET")) {
        expect(check.tier, check.id).not.toBe("read");
      }
    }
  });

  it("allowlists only external checks for the real gateway", () => {
    for (const check of HAND_WRITTEN_CHECKS.filter((candidate) => candidate.realSafe === true)) {
      expect(check.tier, check.id).toBe("external");
    }
  });

  it("tiers every check that can run code on the host as host", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      if (check.routes.some((route) => HOST_ROUTE_PATTERNS.some((pattern) => pattern.test(route)))) {
        expect(check.tier, check.id).toBe("host");
      }
    }
  });

  it("declares step titles for every journey", () => {
    for (const check of HAND_WRITTEN_CHECKS.filter((candidate) => candidate.kind === "journey")) {
      expect(check.steps?.length ?? 0, check.id).toBeGreaterThanOrEqual(2);
    }
  });

  it("labels every hand-written area and title-cases unknown ones", () => {
    for (const check of HAND_WRITTEN_CHECKS) {
      expect(DOMAIN_LABELS[check.domain], check.domain).toBeDefined();
    }
    expect(domainLabel("prompt-packs")).toBe("Prompt packs");
    expect(domainLabel("llm")).toBe("Providers");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/dev-verification.test.ts' 'src/__testbench__/catalog/health.test.ts' 'src/__testbench__/catalog/integrity.test.ts'`
Expected: FAIL, because the catalog modules do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/catalog/dev-verification.ts`:

```ts
import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import type { RouteManifest } from "../runner/routes";
import type { DevVerificationStatus } from "../gateway-target/detect-target";

const DEV_VERIFICATION = "/api/v1/dev/verification";

export interface SessionScope {
  readonly sessionId: string;
  readonly workspaceId: string;
}

export interface SeededWorkspace {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly sessionIds: readonly string[];
}

export interface ChatApprovalScenario extends SessionScope {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly approvalId: string;
  readonly approvalWaitRunId: string;
  readonly chatTurnDurableRunId: string;
}

export interface ChatUserInputScenario extends SessionScope {
  readonly turnId: string;
  readonly userMessageId: string;
  readonly promptId: string;
  readonly chatTurnDurableRunId: string;
}

export interface MemoryItemSeedInput {
  readonly workspaceId: string;
  readonly namespace: string;
  readonly title: string;
  readonly content: string;
}

export interface SeededMemoryItem extends MemoryItemSeedInput {
  readonly itemId: string;
  readonly lifecycleState: string;
}

export interface DurableRecoverySeed {
  readonly orphanRecovery: {
    readonly approvalId: string;
    readonly runId: string;
    readonly status: string;
    readonly leaseExpiresAt: string;
  };
  readonly deadLetterRecovery: {
    readonly approvalId: string;
    readonly runId: string;
    readonly status: string;
    readonly deadLetterId: string;
  };
}

export interface ProviderExerciseResult {
  readonly ok: boolean;
  readonly providerId?: string;
  readonly model?: string;
  readonly elapsedMs?: number;
  readonly outputPreview?: string;
  readonly error?: string;
}

export function fetchDevStatus(): Promise<DevVerificationStatus> {
  return request<DevVerificationStatus>(`${DEV_VERIFICATION}/status`);
}

export function fetchRouteManifest(): Promise<RouteManifest> {
  return request<RouteManifest>(`${DEV_VERIFICATION}/route-access-manifest`);
}

export function seedWorkspace(label: string): Promise<SeededWorkspace> {
  return postJson(`${DEV_VERIFICATION}/seed`, {
    workspaceName: label,
    sessionTitle: `${label} session`,
    sessionCount: 1,
    longThreadTurns: 2,
  });
}

export function seedChatApprovalScenario(scope: SessionScope): Promise<ChatApprovalScenario> {
  return postJson(`${DEV_VERIFICATION}/chat-approval-scenario`, scope);
}

export function seedChatUserInputScenario(scope: SessionScope): Promise<ChatUserInputScenario> {
  return postJson(`${DEV_VERIFICATION}/chat-user-input-scenario`, scope);
}

export function seedMemoryItem(input: MemoryItemSeedInput): Promise<SeededMemoryItem> {
  return postJson(`${DEV_VERIFICATION}/memory-item-seed`, input);
}

export function seedDurableRecovery(): Promise<DurableRecoverySeed> {
  // Fastify rejects an empty body sent with a JSON content type, so send an empty object.
  return postJson(`${DEV_VERIFICATION}/durable-recovery-seed`, {});
}

export function exerciseProvider(input: { readonly scenario: "simple" }): Promise<ProviderExerciseResult> {
  return postJson(`${DEV_VERIFICATION}/provider-exercise`, input);
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body) });
}
```

Create `apps/mission-control-next/src/__testbench__/catalog/domains.ts`:

```ts
export const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  admin: "Admin & backups",
  approvals: "Approvals",
  capabilities: "Capabilities",
  chat: "Chat",
  "code-mode": "Code Mode",
  durable: "Durable runs",
  events: "Realtime",
  health: "Health",
  llm: "Providers",
  memory: "Memory",
  ops: "Ops",
};

export function domainLabel(domain: string): string {
  const known = DOMAIN_LABELS[domain];
  if (known) {
    return known;
  }
  const spaced = domain.replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
```

Create `apps/mission-control-next/src/__testbench__/catalog/health.ts`:

```ts
import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { ensure, fail, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";

interface HealthBody {
  readonly status?: string;
  readonly readiness?: string;
  readonly service?: string;
}

interface LivezBody {
  readonly status?: string;
  readonly uptimeSeconds?: number;
}

interface ReadinessBody extends HealthBody {
  readonly checks?: ReadonlyArray<{ readonly key: string; readonly state?: string }>;
}

/** Health routes answer 503 with a full body when degraded; that is a failure, not a blocked feature. */
async function readAllowingDegraded<T>(path: string, signal: AbortSignal): Promise<{ body: T; degraded: boolean }> {
  try {
    return { body: await request<T>(path, { signal }), degraded: false };
  } catch (error) {
    if (isApiRequestError(error) && error.status === 503 && error.body !== undefined) {
      return { body: error.body as T, degraded: true };
    }
    throw error;
  }
}

export const healthChecks: readonly CheckDef[] = [
  {
    id: "health.gateway",
    kind: "probe",
    domain: "health",
    title: "Gateway health",
    tier: "read",
    routes: ["GET /health"],
    async run(ctx) {
      const { body, degraded } = await readAllowingDegraded<HealthBody>("/health", ctx.signal);
      ensure(body.service === "gateway", "The health endpoint did not identify the gateway service.", body);
      return degraded || body.status !== "ok"
        ? fail(`Gateway health is ${body.status ?? "unknown"} (readiness ${body.readiness ?? "unknown"}).`, body)
        : pass("Gateway reports ok and ready.", body);
    },
  },
  {
    id: "health.livez",
    kind: "probe",
    domain: "health",
    title: "Process liveness",
    tier: "read",
    routes: ["GET /livez"],
    async run(ctx) {
      const body = await request<LivezBody>("/livez", { signal: ctx.signal });
      ensure(body.status === "ok", `Liveness is ${body.status ?? "unknown"}.`, body);
      ensure(typeof body.uptimeSeconds === "number", "Liveness did not report uptime.", body);
      return pass(`Process alive for ${Math.round(body.uptimeSeconds)} s.`, body);
    },
  },
  {
    id: "ops.readiness",
    kind: "probe",
    domain: "ops",
    title: "Operator readiness checks",
    tier: "read",
    routes: ["GET /api/v1/ops/readiness"],
    async run(ctx) {
      const { body, degraded } = await readAllowingDegraded<ReadinessBody>("/api/v1/ops/readiness", ctx.signal);
      const checks = body.checks ?? [];
      ensure(checks.length > 0, "Readiness returned no checks.", body);
      const failing = checks.filter((check) => check.state !== "ready").map((check) => check.key);
      return degraded || failing.length > 0
        ? fail(`Readiness is degraded: ${failing.join(", ") || "unknown checks"}.`, body)
        : pass(`${checks.length} readiness checks are ready.`, body);
    },
  },
];
```

Create `apps/mission-control-next/src/__testbench__/catalog/index.ts`:

```ts
import type { CheckDef } from "../runner/types";
import { healthChecks } from "./health";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [...healthChecks];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/dev-verification.test.ts' 'src/__testbench__/catalog/health.test.ts' 'src/__testbench__/catalog/integrity.test.ts'`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/catalog/dev-verification.ts apps/mission-control-next/src/__testbench__/catalog/dev-verification.test.ts apps/mission-control-next/src/__testbench__/catalog/domains.ts apps/mission-control-next/src/__testbench__/catalog/health.ts apps/mission-control-next/src/__testbench__/catalog/health.test.ts apps/mission-control-next/src/__testbench__/catalog/index.ts apps/mission-control-next/src/__testbench__/catalog/integrity.test.ts
git commit -m "feat(testbench): add the catalog foundation and health checks"
```

---

### Task 10: Load lifecycle and run controller hook

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/ui/use-testbench.ts`
- Test: `apps/mission-control-next/src/__testbench__/ui/use-testbench.test.ts`

**Interfaces:**
- Consumes: `getGatewayApiBaseUrl()`, `preflightGatewayAccess()` from `@goatcitadel/mission-control-shared/api/client-core`; `HAND_WRITTEN_CHECKS` (Task 9); `buildAutoProbes` (Task 5); `fetchDevStatus`, `fetchRouteManifest`, `seedWorkspace` (Task 9); `classifyError` (Task 4); `computeCoverage`, `trackedRouteKeys` (Task 5); `runChecks`, `RunSeed` (Task 7); `runReducer`, `INITIAL_RUN_STATE` (Task 6); `detectTarget` (Task 2).
- Produces: `GatewayAccessStatus`, `TestbenchDeps { apiBase; preflight; fetchStatus; fetchManifest; seed; handWritten }`, `DEFAULT_TESTBENCH_DEPS`, `ReadyLoad`, `LoadState`, `TestbenchController { load; runState; coverage; options; setAllowHost; run(checkIds, confirmExternalId?); stop }`, `loadTestbench(targetRequest, env, deps)`, `useTestbench(targetRequest, env, deps)`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/ui/use-testbench.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { TestbenchEnv } from "../env";
import { pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { loadTestbench, type TestbenchDeps } from "./use-testbench";

const ENV: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "/tmp/sandbox",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};

const SANDBOX_REQUEST: TargetRequest = { requested: "sandbox", origin: ENV.sandboxOrigin };

const HAND_WRITTEN: CheckDef[] = [
  {
    id: "demo.read",
    kind: "probe",
    domain: "health",
    title: "Demo read",
    tier: "read",
    routes: ["GET /api/v1/demo"],
    run: async () => pass("ok"),
  },
];

function makeDeps(overrides: Partial<TestbenchDeps> = {}): TestbenchDeps {
  return {
    apiBase: () => "http://127.0.0.1:41873",
    preflight: async () => ({ status: "ready", message: "Gateway ready." }),
    fetchStatus: async () => ({ diagnosticsEnabled: true, rootDir: "/tmp/sandbox" }),
    fetchManifest: async () => ({
      items: [
        { method: "GET", url: "/api/v1/demo", tracked: true, accessClass: "operator" },
        { method: "GET", url: "/api/v1/workspaces", tracked: true, accessClass: "operator" },
      ],
    }),
    seed: vi.fn(async () => ({ workspaceId: "ws-test" })),
    handWritten: HAND_WRITTEN,
    ...overrides,
  };
}

describe("loadTestbench", () => {
  it("verifies the sandbox, appends auto-probes, and keeps the tracked route keys", async () => {
    const load = await loadTestbench(SANDBOX_REQUEST, ENV, makeDeps());
    expect(load).toMatchObject({
      phase: "ready",
      target: { kind: "sandbox", sandboxVerified: true },
      manifestKeys: ["GET /api/v1/demo", "GET /api/v1/workspaces"],
      manifestError: undefined,
    });
    expect(load.phase === "ready" ? load.checks.map((check) => check.id) : []).toEqual([
      "demo.read",
      "auto:GET /api/v1/workspaces",
    ]);
  });

  it("explains gateways that need sign-in, are unreachable, or are misconfigured", async () => {
    await expect(
      loadTestbench(SANDBOX_REQUEST, ENV, makeDeps({ preflight: async () => ({ status: "needs-auth", message: "Token required." }) })),
    ).resolves.toMatchObject({ phase: "blocked", title: "This gateway needs you to sign in" });
    await expect(
      loadTestbench(SANDBOX_REQUEST, ENV, makeDeps({ preflight: async () => ({ status: "unreachable", message: "Network error." }) })),
    ).resolves.toMatchObject({ phase: "blocked", title: "Gateway unreachable", detail: expect.stringContaining("port 5173") });
    await expect(
      loadTestbench(SANDBOX_REQUEST, ENV, makeDeps({ preflight: async () => ({ status: "misconfigured", message: "Bad URL." }) })),
    ).resolves.toMatchObject({ phase: "blocked", title: "Gateway access is misconfigured", detail: "Bad URL." });
  });

  it("reports an unavailable route list without inventing coverage", async () => {
    const load = await loadTestbench(
      SANDBOX_REQUEST,
      ENV,
      makeDeps({
        fetchManifest: async () => {
          throw new Error("API error 404: Development verification endpoints are disabled.");
        },
      }),
    );
    expect(load).toMatchObject({
      phase: "ready",
      manifestKeys: undefined,
      manifestError: "API error 404: Development verification endpoints are disabled.",
    });
    expect(load.phase === "ready" ? load.checks.map((check) => check.id) : []).toEqual(["demo.read"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/ui/use-testbench.test.ts'`
Expected: FAIL, because `./use-testbench` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/ui/use-testbench.ts`:

```ts
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getGatewayApiBaseUrl, preflightGatewayAccess } from "@goatcitadel/mission-control-shared/api/client-core";
import { HAND_WRITTEN_CHECKS } from "../catalog";
import { buildAutoProbes } from "../catalog/auto-probes";
import { fetchDevStatus, fetchRouteManifest, seedWorkspace } from "../catalog/dev-verification";
import type { TestbenchEnv } from "../env";
import { classifyError } from "../runner/classify";
import { computeCoverage, trackedRouteKeys, type CoverageReport, type RouteManifest } from "../runner/routes";
import { runChecks, type RunSeed } from "../runner/scheduler";
import { INITIAL_RUN_STATE, runReducer, type RunState } from "../runner/state";
import type { CheckDef, RouteKey, RunOptions } from "../runner/types";
import { detectTarget, type DevVerificationStatus, type TargetInfo } from "../gateway-target/detect-target";
import type { TargetRequest } from "../gateway-target/resolve-target";

export type GatewayAccessStatus = "ready" | "needs-auth" | "unreachable" | "misconfigured";

export interface TestbenchDeps {
  readonly apiBase: () => string;
  readonly preflight: () => Promise<{ readonly status: GatewayAccessStatus; readonly message: string }>;
  readonly fetchStatus: () => Promise<DevVerificationStatus>;
  readonly fetchManifest: () => Promise<RouteManifest>;
  readonly seed: (signal: AbortSignal) => Promise<RunSeed>;
  readonly handWritten: readonly CheckDef[];
}

export const DEFAULT_TESTBENCH_DEPS: TestbenchDeps = {
  apiBase: getGatewayApiBaseUrl,
  preflight: () => preflightGatewayAccess(),
  fetchStatus: fetchDevStatus,
  fetchManifest: fetchRouteManifest,
  seed: async () => {
    const seeded = await seedWorkspace(`Test bench run ${new Date().toISOString()}`);
    return { workspaceId: seeded.workspaceId };
  },
  handWritten: HAND_WRITTEN_CHECKS,
};

export interface ReadyLoad {
  readonly phase: "ready";
  readonly target: TargetInfo;
  readonly manifestKeys: readonly RouteKey[] | undefined;
  readonly manifestError: string | undefined;
  readonly checks: readonly CheckDef[];
}

export type LoadState =
  | { readonly phase: "loading" }
  | { readonly phase: "blocked"; readonly title: string; readonly detail: string }
  | ReadyLoad;

export interface TestbenchController {
  readonly load: LoadState;
  readonly runState: RunState;
  readonly coverage: CoverageReport | undefined;
  readonly options: RunOptions;
  readonly setAllowHost: (value: boolean) => void;
  readonly run: (checkIds: readonly string[], confirmExternalId?: string) => void;
  readonly stop: () => void;
}

export async function loadTestbench(
  targetRequest: TargetRequest,
  env: TestbenchEnv,
  deps: TestbenchDeps,
): Promise<LoadState> {
  const access = await deps.preflight();
  if (access.status !== "ready") {
    return describeBlockedAccess(access.status, access.message);
  }
  const target = await detectTarget(targetRequest, env, { apiBase: deps.apiBase(), fetchStatus: deps.fetchStatus });
  const manifestResult = await deps.fetchManifest().then(
    (manifest) => ({ manifest, error: undefined }),
    (error: unknown) => ({ manifest: undefined, error: classifyError(error).summary }),
  );
  const autoProbes = manifestResult.manifest
    ? buildAutoProbes(manifestResult.manifest, deps.handWritten, target.kind)
    : [];
  return {
    phase: "ready",
    target,
    manifestKeys: manifestResult.manifest ? trackedRouteKeys(manifestResult.manifest) : undefined,
    manifestError: manifestResult.error,
    checks: [...deps.handWritten, ...autoProbes],
  };
}

function describeBlockedAccess(status: Exclude<GatewayAccessStatus, "ready">, message: string): LoadState {
  switch (status) {
    case "needs-auth":
      return {
        phase: "blocked",
        title: "This gateway needs you to sign in",
        detail: `${message} Sign in through Mission Control on this same address, then reload the test bench.`,
      };
    case "unreachable":
      return {
        phase: "blocked",
        title: "Gateway unreachable",
        detail: `${message} If this is an installed GoatCitadel, open the test bench from the dev server on port 5173: production gateways only accept browser requests from that origin.`,
      };
    case "misconfigured":
      return { phase: "blocked", title: "Gateway access is misconfigured", detail: message };
  }
}

export function useTestbench(
  targetRequest: TargetRequest,
  env: TestbenchEnv,
  deps: TestbenchDeps,
): TestbenchController {
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });
  const [runState, dispatch] = useReducer(runReducer, INITIAL_RUN_STATE);
  const [allowHost, setAllowHost] = useState(false);
  const [confirmedExternalIds, setConfirmedExternalIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadTestbench(targetRequest, env, deps).then(
      (next) => {
        if (!cancelled) {
          setLoad(next);
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setLoad({ phase: "blocked", title: "The test bench could not start", detail: classifyError(error).summary });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [targetRequest, env, deps]);

  useEffect(() => {
    const activeRun = controllerRef;
    return () => {
      activeRun.current?.abort();
    };
  }, []);

  const coverage = useMemo(
    () => (load.phase === "ready" ? computeCoverage(load.manifestKeys, load.checks) : undefined),
    [load],
  );
  const options = useMemo<RunOptions>(() => ({ allowHost, confirmedExternalIds }), [allowHost, confirmedExternalIds]);

  const run = useCallback(
    (checkIds: readonly string[], confirmExternalId?: string) => {
      if (load.phase !== "ready" || controllerRef.current) {
        return;
      }
      const confirmed =
        confirmExternalId === undefined ? confirmedExternalIds : new Set([...confirmedExternalIds, confirmExternalId]);
      if (confirmExternalId !== undefined) {
        setConfirmedExternalIds(confirmed);
      }
      const wanted = new Set(checkIds);
      const controller = new AbortController();
      controllerRef.current = controller;
      void runChecks({
        checks: load.checks.filter((check) => wanted.has(check.id)),
        target: load.target,
        options: { allowHost, confirmedExternalIds: confirmed },
        signal: controller.signal,
        emit: dispatch,
        seed: deps.seed,
      }).finally(() => {
        controllerRef.current = null;
      });
    },
    [load, allowHost, confirmedExternalIds, deps],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  return { load, runState, coverage, options, setAllowHost, run, stop };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/ui/use-testbench.test.ts'`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/ui/use-testbench.ts apps/mission-control-next/src/__testbench__/ui/use-testbench.test.ts
git commit -m "feat(testbench): load the target and route list and drive runs"
```

---

### Task 11: Page entry and the three-pane UI

**Files:**
- Create: `apps/mission-control-next/testbench.html`
- Create: `apps/mission-control-next/src/__testbench__/main.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/mount.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/TestbenchApp.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/TopBar.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/FilterBar.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/AreaRail.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/CheckList.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/CheckDrawer.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/UncoveredRoutes.tsx`
- Create: `apps/mission-control-next/src/__testbench__/ui/testbench.css`
- Test: `apps/mission-control-next/src/__testbench__/main.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/ui/TestbenchApp.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–10; primitives `StatusChip`, `NativeButton`, `NoticeBanner`, `ErrorState`, `EmptyState` from `@next/features/native-routes/primitives`; `ConfirmModal` from `@goatcitadel/mission-control-shared/components/ConfirmModal` (props `open`, `title`, `message: string`, `confirmLabel?`, `onConfirm`, `onCancel`).
- Produces: `mountTestbench(container, targetRequest, env)`, `TestbenchApp({ targetRequest, env, deps? })`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/main.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

const { mountMock } = vi.hoisted(() => ({ mountMock: vi.fn() }));
vi.mock("./ui/mount", () => ({ mountTestbench: mountMock }));

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  mountMock.mockReset();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("test bench entry", () => {
  it("resolves the target from the URL and mounts the app", async () => {
    document.body.innerHTML = '<div id="testbench-root"></div>';
    window.history.replaceState(null, "", "/testbench.html?target=real");
    await import("./main");
    await vi.waitFor(() => expect(mountMock).toHaveBeenCalledTimes(1));
    const [container, request] = mountMock.mock.calls[0] ?? [];
    expect((container as HTMLElement).id).toBe("testbench-root");
    expect(request).toEqual({ requested: "real", origin: undefined });
  });

  it("refuses to run in a production build", async () => {
    vi.stubEnv("PROD", true);
    document.body.innerHTML = '<div id="testbench-root"></div>';
    await import("./main");
    expect(document.body.textContent).toContain("does not run in production builds");
    expect(mountMock).not.toHaveBeenCalled();
  });
});
```

Create `apps/mission-control-next/src/__testbench__/ui/TestbenchApp.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestbenchEnv } from "../env";
import { fail, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { TestbenchApp } from "./TestbenchApp";
import type { TestbenchDeps } from "./use-testbench";

interface ConfirmStubProps {
  readonly open: boolean;
  readonly title: string;
  readonly message: string;
  readonly confirmLabel?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

vi.mock("@goatcitadel/mission-control-shared/components/ConfirmModal", async () => {
  const { createElement } = await import("react");
  return {
    ConfirmModal: (props: ConfirmStubProps) =>
      props.open
        ? createElement(
            "div",
            { role: "dialog", "aria-label": props.title },
            createElement("p", null, props.message),
            createElement("button", { type: "button", onClick: props.onConfirm }, props.confirmLabel ?? "Confirm"),
            createElement("button", { type: "button", onClick: props.onCancel }, "Cancel"),
          )
        : null,
  };
});

const ENV: TestbenchEnv = {
  sandboxOrigin: "http://127.0.0.1:41873",
  sandboxRoot: "/tmp/sandbox",
  realOrigin: "http://127.0.0.1:8787",
  isProd: false,
};
const SANDBOX_REQUEST: TargetRequest = { requested: "sandbox", origin: ENV.sandboxOrigin };
const REAL_REQUEST: TargetRequest = { requested: "real", origin: ENV.realOrigin };

function makeChecks() {
  const external = vi.fn(async () => pass("External ok."));
  const checks: CheckDef[] = [
    { id: "demo.read", kind: "probe", domain: "health", title: "Demo read", tier: "read", routes: ["GET /api/v1/demo"], run: async () => pass("Read ok.") },
    { id: "demo.mutate", kind: "probe", domain: "chat", title: "Demo mutate", tier: "mutate", routes: ["POST /api/v1/demo"], run: async () => pass("Mutate ok.") },
    {
      id: "demo.journey",
      kind: "journey",
      domain: "chat",
      title: "Demo journey",
      tier: "mutate",
      routes: ["POST /api/v1/demo"],
      steps: ["First step", "Second step"],
      run: async (ctx) => {
        await ctx.step("First step", async () => undefined);
        return fail("Second step never ran.");
      },
    },
    { id: "demo.host", kind: "probe", domain: "code-mode", title: "Demo host", tier: "host", routes: ["POST /api/v1/code-mode/runs"], run: async () => pass("Host ok.") },
    {
      id: "demo.external",
      kind: "probe",
      domain: "llm",
      title: "Demo external",
      tier: "external",
      realSafe: true,
      routes: ["POST /api/v1/dev/verification/provider-exercise"],
      description: "Spends tokens.",
      run: external,
    },
  ];
  return { checks, external };
}

function makeDeps(handWritten: readonly CheckDef[], overrides: Partial<TestbenchDeps> = {}): TestbenchDeps {
  return {
    apiBase: () => "http://127.0.0.1:41873",
    preflight: async () => ({ status: "ready", message: "Gateway ready." }),
    fetchStatus: async () => ({ diagnosticsEnabled: true, rootDir: "/tmp/sandbox" }),
    fetchManifest: async () => ({
      items: [
        { method: "GET", url: "/api/v1/demo", tracked: true, accessClass: "operator" },
        { method: "POST", url: "/api/v1/demo", tracked: true, accessClass: "operator" },
        { method: "GET", url: "/api/v1/uncovered/:thingId", tracked: true, accessClass: "operator" },
      ],
    }),
    seed: async () => ({ workspaceId: "ws-test" }),
    handWritten,
    ...overrides,
  };
}

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

async function render(ui: ReactElement): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(ui);
  });
}

function text(): string {
  return document.body.textContent ?? "";
}

async function waitForText(expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (text().includes(expected)) {
      return;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`Text not found: ${expected}\n${text()}`);
}

function buttonNamed(name: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  );
  if (!found) {
    throw new Error(`No button named ${name}`);
  }
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe("TestbenchApp", () => {
  it("shows the verified sandbox, the coverage meter, and every check", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("SANDBOX ✓ verified");
    expect(text()).toContain("Coverage 2 / 3 routes (67%)");
    expect(text()).toContain("Demo journey");
  });

  it("runs every allowed check, skips the rest, and announces the result", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Run all allowed");
    await click(buttonNamed("Run all allowed"));
    await waitForText("Run completed: 2 pass, 1 fail, 0 blocked, 2 skipped.");
    expect(text()).toContain("Host checks are off for this run.");
  });

  it("runs a host check once the per-run opt-in is ticked", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Allow host checks");
    expect(buttonNamed("Run Demo host").disabled).toBe(true);
    const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await click(toggle as HTMLInputElement);
    expect(buttonNamed("Run Demo host").disabled).toBe(false);
  });

  it("keeps mutating checks disabled with the reason on the real gateway", async () => {
    const deps = makeDeps(makeChecks().checks, { apiBase: () => "http://127.0.0.1:8787" });
    await render(<TestbenchApp targetRequest={REAL_REQUEST} env={ENV} deps={deps} />);
    await waitForText("REAL gateway");
    expect(text()).toContain("Mutating checks never run on the real gateway.");
    expect(buttonNamed("Run Demo mutate").disabled).toBe(true);
  });

  it("asks for confirmation before an external check and runs it once confirmed", async () => {
    const { checks, external } = makeChecks();
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(checks)} />);
    await waitForText("Demo external");
    await click(buttonNamed("Run Demo external"));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Spends tokens.");
    expect(external).not.toHaveBeenCalled();
    await click(buttonNamed("Run it"));
    await waitForText("Run completed: 1 pass");
    expect(external).toHaveBeenCalledTimes(1);
  });

  it("shows journey steps, including steps that never ran, in the drawer", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Run all allowed");
    await click(buttonNamed("Run all allowed"));
    await waitForText("Run completed");
    const journeyRow = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testbench-row]")).find((row) =>
      row.textContent?.includes("Demo journey"),
    );
    await click(journeyRow as HTMLButtonElement);
    const drawer = document.querySelector('aside[aria-label="Demo journey details"]');
    expect(drawer?.textContent).toContain("✓ First step");
    expect(drawer?.textContent).toContain("Second step (not run)");
    expect(drawer?.textContent).toContain("Second step never ran.");
  });

  it("lists uncovered routes and stale claims", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Uncovered routes (1)");
    await click(buttonNamed("Uncovered routes (1)"));
    expect(text()).toContain("GET /api/v1/uncovered/:thingId");
    expect(text()).toContain("claimed by demo.host");
  });

  it("copies a Markdown report", async () => {
    const writeText = vi.fn(async (_markdown: string) => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText }, configurable: true });
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Copy report");
    await click(buttonNamed("Copy report"));
    await waitForText("Report copied as Markdown.");
    expect(writeText.mock.calls[0]?.[0]).toContain("# GoatCitadel test bench report");
  });

  it("explains an unreachable gateway with the dev-server hint", async () => {
    const deps = makeDeps([], { preflight: async () => ({ status: "unreachable", message: "Network error." }) });
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={deps} />);
    await waitForText("Gateway unreachable");
    expect(text()).toContain("port 5173");
  });

  it("reports coverage as unavailable when the route list cannot be read", async () => {
    const deps = makeDeps(makeChecks().checks, {
      fetchManifest: async () => {
        throw new Error("API error 404");
      },
    });
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={deps} />);
    await waitForText("Coverage unavailable: API error 404");
  });

  it("moves focus between rows with the arrow keys", async () => {
    await render(<TestbenchApp targetRequest={SANDBOX_REQUEST} env={ENV} deps={makeDeps(makeChecks().checks)} />);
    await waitForText("Demo read");
    const rows = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-testbench-row]"));
    rows[0]?.focus();
    await act(async () => {
      rows[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(rows[1]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/main.test.ts' 'src/__testbench__/ui/TestbenchApp.test.tsx'`
Expected: FAIL, because `./main`, `./ui/mount`, and `./TestbenchApp` do not exist.

- [ ] **Step 3: Create the page entry**

Create `apps/mission-control-next/testbench.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>GoatCitadel test bench</title>
  </head>
  <body>
    <div id="testbench-root"></div>
    <script type="module" src="/src/__testbench__/main.tsx"></script>
  </body>
</html>
```

Create `apps/mission-control-next/src/__testbench__/main.tsx`:

```tsx
import { readTestbenchEnv } from "./env";
import { applyGatewayOriginMeta, resolveTargetRequest } from "./gateway-target/resolve-target";

const PRODUCTION_REFUSAL = "The GoatCitadel test bench is a development tool and does not run in production builds.";

const env = readTestbenchEnv();
const container = document.getElementById("testbench-root");

if (container) {
  if (env.isProd) {
    container.textContent = PRODUCTION_REFUSAL;
  } else {
    const targetRequest = resolveTargetRequest(window.location.search, env);
    // The shared client reads this tag once at module load, so it must exist before the app is imported.
    applyGatewayOriginMeta(document, targetRequest.origin);
    void import("./ui/mount").then(({ mountTestbench }) => mountTestbench(container, targetRequest, env));
  }
}
```

Create `apps/mission-control-next/src/__testbench__/ui/mount.tsx`:

```tsx
import { createRoot } from "react-dom/client";
import "@next/styles/mission-control-next-tokens.css";
import "@next/styles/mission-control-next-foundation.css";
import "@next/styles/mission-control-next-theme-bridge.css";
import "@next/styles/mission-control-next.css";
import "@next/features/native-routes/primitives/primitives.css";
import "./testbench.css";
import type { TestbenchEnv } from "../env";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { TestbenchApp } from "./TestbenchApp";

const THEME_CLASS = "theme-signal-noir";

export function mountTestbench(container: HTMLElement, targetRequest: TargetRequest, env: TestbenchEnv): void {
  // Theme on html and body so content portaled to body (dialogs) inherits it, as in the main app.
  document.documentElement.classList.add(THEME_CLASS);
  document.body.classList.add(THEME_CLASS);
  createRoot(container).render(<TestbenchApp targetRequest={targetRequest} env={env} />);
}
```

- [ ] **Step 4: Create the top bar, filter bar, and area rail**

Create `apps/mission-control-next/src/__testbench__/ui/TopBar.tsx`:

```tsx
import { NativeButton, StatusChip } from "@next/features/native-routes/primitives";
import { describeCoverage } from "../runner/report";
import type { CoverageReport } from "../runner/routes";
import type { TargetInfo } from "../gateway-target/detect-target";
import { buildTargetHref } from "../gateway-target/resolve-target";

export interface TopBarProps {
  readonly target: TargetInfo;
  readonly coverage: CoverageReport | undefined;
  readonly manifestError: string | undefined;
  readonly running: boolean;
  readonly allowHost: boolean;
  readonly copyNotice: string | undefined;
  readonly onAllowHostChange: (value: boolean) => void;
  readonly onRunAll: () => void;
  readonly onStop: () => void;
  readonly onCopyReport: () => void;
}

export function TopBar(props: TopBarProps) {
  const { target } = props;
  const otherTarget = target.requested === "sandbox" ? "real" : "sandbox";
  return (
    <header className="testbench-topbar">
      <div className="testbench-target">
        <StatusChip tone={target.kind === "sandbox" ? "success" : "warning"}>
          {target.kind === "sandbox" ? "SANDBOX ✓ verified" : "REAL gateway"}
        </StatusChip>
        <span className="testbench-meta">
          {target.origin}
          {target.rootDir ? ` · root ${target.rootDir}` : ""}
        </span>
        {target.reason ? <span className="testbench-meta testbench-warning">{target.reason}</span> : null}
        <a className="testbench-link" href={buildTargetHref(window.location.href, otherTarget)}>
          {otherTarget === "real" ? "Switch to the real gateway" : "Switch to the sandbox"}
        </a>
      </div>
      <CoverageMeter coverage={props.coverage} manifestError={props.manifestError} />
      <div className="testbench-actions">
        <label className="testbench-toggle">
          <input
            type="checkbox"
            checked={props.allowHost}
            disabled={target.kind !== "sandbox" || props.running}
            onChange={(event) => props.onAllowHostChange(event.currentTarget.checked)}
          />
          Allow host checks
        </label>
        <NativeButton type="button" onClick={props.onRunAll} disabled={props.running}>
          Run all allowed
        </NativeButton>
        <NativeButton type="button" variant="outline" onClick={props.onStop} disabled={!props.running}>
          Stop
        </NativeButton>
        <NativeButton type="button" variant="outline" onClick={props.onCopyReport}>
          Copy report
        </NativeButton>
      </div>
      {props.copyNotice ? (
        <span className="testbench-meta" role="status">
          {props.copyNotice}
        </span>
      ) : null}
    </header>
  );
}

function CoverageMeter({
  coverage,
  manifestError,
}: {
  readonly coverage: CoverageReport | undefined;
  readonly manifestError: string | undefined;
}) {
  if (!coverage) {
    return (
      <div className="testbench-coverage">
        <span className="testbench-meta">{`Coverage unavailable${manifestError ? `: ${manifestError}` : ""}`}</span>
      </div>
    );
  }
  return (
    <div className="testbench-coverage">
      <span className="testbench-meta">{`Coverage ${describeCoverage(coverage)}`}</span>
      <progress
        className="testbench-progress"
        max={Math.max(1, coverage.total)}
        value={coverage.covered}
        aria-label="Route coverage"
      />
    </div>
  );
}
```

Create `apps/mission-control-next/src/__testbench__/ui/FilterBar.tsx`:

```tsx
import type { StatusCounts } from "../runner/state";
import type { CheckTier } from "../runner/types";
import { countForFilter, toggleTier, type CheckFilters, type StatusFilter } from "./filters";

const STATUS_FILTERS: ReadonlyArray<{ readonly value: StatusFilter; readonly label: string }> = [
  { value: "all", label: "All" },
  { value: "failing", label: "✕ Failing" },
  { value: "blocked", label: "◐ Blocked" },
  { value: "skipped", label: "– Skipped" },
  { value: "not-run", label: "○ Not run" },
];

const TIERS: readonly CheckTier[] = ["read", "mutate", "host", "external"];

export interface FilterBarProps {
  readonly filters: CheckFilters;
  readonly counts: StatusCounts;
  readonly onChange: (filters: CheckFilters) => void;
}

export function FilterBar({ filters, counts, onChange }: FilterBarProps) {
  return (
    <div className="testbench-filters" role="group" aria-label="Filters">
      {STATUS_FILTERS.map((option) => (
        <button
          key={option.value}
          type="button"
          className="testbench-chip"
          aria-pressed={filters.status === option.value}
          onClick={() => onChange({ ...filters, status: option.value })}
        >
          {option.value === "all" ? option.label : `${option.label} ${countForFilter(counts, option.value)}`}
        </button>
      ))}
      <span className="testbench-divider" aria-hidden="true" />
      {TIERS.map((tier) => (
        <button
          key={tier}
          type="button"
          className="testbench-chip"
          aria-pressed={filters.tiers.has(tier)}
          onClick={() => onChange({ ...filters, tiers: toggleTier(filters.tiers, tier) })}
        >
          {tier}
        </button>
      ))}
      <input
        className="testbench-search"
        type="search"
        placeholder="Search checks and routes"
        aria-label="Search checks and routes"
        value={filters.query}
        onChange={(event) => onChange({ ...filters, query: event.currentTarget.value })}
      />
    </div>
  );
}
```

Create `apps/mission-control-next/src/__testbench__/ui/AreaRail.tsx`:

```tsx
import type { DomainSummary } from "./filters";

export interface AreaRailProps {
  readonly domains: readonly DomainSummary[];
  readonly selected: string | undefined;
  readonly onSelect: (domain: string | undefined) => void;
}

export function AreaRail({ domains, selected, onSelect }: AreaRailProps) {
  return (
    <nav className="testbench-rail" aria-label="Areas">
      <select
        className="testbench-rail-select"
        aria-label="Area"
        value={selected ?? ""}
        onChange={(event) => onSelect(event.currentTarget.value || undefined)}
      >
        <option value="">All areas</option>
        {domains.map((summary) => (
          <option key={summary.domain} value={summary.domain}>
            {`${summary.label} (${summary.passed}/${summary.total})`}
          </option>
        ))}
      </select>
      <ul className="testbench-rail-list">
        <li>
          <button type="button" aria-current={selected === undefined ? "true" : undefined} onClick={() => onSelect(undefined)}>
            <span>All areas</span>
          </button>
        </li>
        {domains.map((summary) => (
          <li key={summary.domain}>
            <button
              type="button"
              aria-current={selected === summary.domain ? "true" : undefined}
              onClick={() => onSelect(summary.domain)}
            >
              <span>{summary.label}</span>
              <span className="testbench-meta">
                {`${summary.failing > 0 ? `✕ ${summary.failing} · ` : ""}${summary.passed}/${summary.total}`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 5: Create the check list, drawer, and uncovered-routes view**

Create `apps/mission-control-next/src/__testbench__/ui/CheckList.tsx`:

```tsx
import { useRef, useState, type KeyboardEvent } from "react";
import { EmptyState, NativeButton, StatusChip } from "@next/features/native-routes/primitives";
import type { Permission } from "../runner/policy";
import { recordFor, type CheckRecord, type RunState } from "../runner/state";
import type { CheckDef } from "../runner/types";
import { KIND_LABELS, STATUS_DISPLAY, formatDuration } from "./status-display";

export const CHECK_PAGE_SIZE = 200;

export interface CheckListProps {
  readonly checks: readonly CheckDef[];
  readonly state: RunState;
  readonly selectedId: string | undefined;
  readonly running: boolean;
  readonly onSelect: (checkId: string) => void;
  readonly onRun: (check: CheckDef) => void;
  readonly permissionOf: (check: CheckDef) => Permission;
}

export function CheckList({ checks, state, selectedId, running, onSelect, onRun, permissionOf }: CheckListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [limit, setLimit] = useState(CHECK_PAGE_SIZE);
  if (checks.length === 0) {
    return (
      <section className="testbench-list" aria-label="Checks">
        <EmptyState size="compact" title="No checks match these filters." />
      </section>
    );
  }
  const hidden = checks.length - limit;
  const moveFocus = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-testbench-row]") ?? []);
    const current = rows.findIndex((row) => row === document.activeElement);
    const next = rows[event.key === "ArrowDown" ? Math.min(rows.length - 1, current + 1) : Math.max(0, current - 1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };
  return (
    <section className="testbench-list" aria-label="Checks">
      <ul ref={listRef} onKeyDown={moveFocus}>
        {checks.slice(0, limit).map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            record={recordFor(state, check.id)}
            selected={check.id === selectedId}
            running={running}
            permission={permissionOf(check)}
            onSelect={onSelect}
            onRun={onRun}
          />
        ))}
      </ul>
      {hidden > 0 ? (
        <NativeButton
          type="button"
          variant="outline"
          className="testbench-more"
          onClick={() => setLimit(limit + CHECK_PAGE_SIZE)}
        >
          {`Show ${Math.min(CHECK_PAGE_SIZE, hidden)} more (${hidden} hidden)`}
        </NativeButton>
      ) : null}
    </section>
  );
}

interface CheckRowProps {
  readonly check: CheckDef;
  readonly record: CheckRecord;
  readonly selected: boolean;
  readonly running: boolean;
  readonly permission: Permission;
  readonly onSelect: (checkId: string) => void;
  readonly onRun: (check: CheckDef) => void;
}

function CheckRow({ check, record, selected, running, permission, onSelect, onRun }: CheckRowProps) {
  const display = STATUS_DISPLAY[record.status];
  return (
    <li className="testbench-row" data-selected={selected ? "true" : undefined}>
      <button
        type="button"
        className="testbench-row-main"
        data-testbench-row=""
        aria-pressed={selected}
        onClick={() => onSelect(check.id)}
      >
        <StatusChip tone={display.tone} size="sm">{`${display.icon} ${display.label}`}</StatusChip>
        <span className="testbench-row-title">
          {check.title} <span className="testbench-meta">{KIND_LABELS[check.kind]}</span>
        </span>
        <span className="testbench-tier">{check.tier}</span>
        <span className="testbench-meta testbench-duration">
          {record.durationMs === undefined ? "—" : formatDuration(record.durationMs)}
        </span>
      </button>
      <NativeButton
        type="button"
        variant="outline"
        aria-label={`Run ${check.title}`}
        disabled={running || !permission.allowed}
        onClick={() => onRun(check)}
      >
        Run
      </NativeButton>
      {permission.allowed ? null : <span className="testbench-meta testbench-reason">{permission.reason}</span>}
    </li>
  );
}
```

Create `apps/mission-control-next/src/__testbench__/ui/CheckDrawer.tsx`:

```tsx
import { NativeButton, StatusChip } from "@next/features/native-routes/primitives";
import type { CheckRecord } from "../runner/state";
import type { CheckDef } from "../runner/types";
import { STATUS_DISPLAY, STEP_ICON, formatEvidence } from "./status-display";

export interface CheckDrawerProps {
  readonly check: CheckDef | undefined;
  readonly record: CheckRecord | undefined;
  readonly onClose: () => void;
}

export function CheckDrawer({ check, record, onClose }: CheckDrawerProps) {
  if (!check || !record) {
    return (
      <aside className="testbench-drawer testbench-drawer-empty" aria-label="Check details">
        <p className="testbench-meta">Select a check to see its steps and evidence.</p>
      </aside>
    );
  }
  const display = STATUS_DISPLAY[record.status];
  const reached = new Set(record.steps.map((step) => step.title));
  const unreached = (check.steps ?? []).filter((title) => !reached.has(title));
  return (
    <aside className="testbench-drawer" aria-label={`${check.title} details`}>
      <header className="testbench-drawer-header">
        <h2>{check.title}</h2>
        <NativeButton type="button" variant="ghost" aria-label="Close details" onClick={onClose}>
          Close
        </NativeButton>
      </header>
      <p>
        <StatusChip tone={display.tone}>{`${display.icon} ${display.label}`}</StatusChip>{" "}
        <span className="testbench-tier">{check.tier}</span>
      </p>
      {record.summary ? <p className="testbench-summary">{record.summary}</p> : null}
      {check.description ? <p className="testbench-meta">{check.description}</p> : null}
      {record.steps.length > 0 || unreached.length > 0 ? (
        <ol className="testbench-steps">
          {record.steps.map((step, index) => (
            <li key={`${step.title}-${index}`}>{`${STEP_ICON[step.status]} ${step.title}`}</li>
          ))}
          {unreached.map((title) => (
            <li key={`unreached-${title}`} className="testbench-meta">{`– ${title} (not run)`}</li>
          ))}
        </ol>
      ) : null}
      <h3>Routes</h3>
      <ul className="testbench-routes">
        {check.routes.map((route) => (
          <li key={route}>
            <code>{route}</code>
          </li>
        ))}
      </ul>
      {record.log.length > 0 ? (
        <details>
          <summary>{`Log (${record.log.length})`}</summary>
          <ul className="testbench-routes">
            {record.log.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>{`${entry.at} ${entry.message}`}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {record.evidence !== undefined ? (
        <details className="testbench-raw">
          <summary>Raw response (secondary detail)</summary>
          <pre>{formatEvidence(record.evidence)}</pre>
        </details>
      ) : null}
    </aside>
  );
}
```

Create `apps/mission-control-next/src/__testbench__/ui/UncoveredRoutes.tsx`:

```tsx
import { EmptyState } from "@next/features/native-routes/primitives";
import type { CoverageReport } from "../runner/routes";
import { groupRoutesByDomain } from "./filters";

export interface UncoveredRoutesProps {
  readonly coverage: CoverageReport | undefined;
  readonly labelFor: (domain: string) => string;
}

export function UncoveredRoutes({ coverage, labelFor }: UncoveredRoutesProps) {
  if (!coverage) {
    return (
      <EmptyState
        title="Route list unavailable"
        description="This gateway did not serve its route list, so uncovered routes cannot be listed. Development verification endpoints may be off."
      />
    );
  }
  return (
    <section className="testbench-uncovered" aria-label="Uncovered routes">
      <p className="testbench-meta">{`${coverage.uncovered.length} of ${coverage.total} routes have no check yet.`}</p>
      {coverage.staleClaims.length > 0 ? (
        <>
          <h2>Stale claims</h2>
          <ul>
            {coverage.staleClaims.map((claim) => (
              <li key={`${claim.checkId}:${claim.route}`}>
                <code>{claim.route}</code>
                {` claimed by ${claim.checkId} but missing from the route list`}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {groupRoutesByDomain(coverage.uncovered).map(([domain, routes]) => (
        <details key={domain}>
          <summary>{`${labelFor(domain)} (${routes.length})`}</summary>
          <ul>
            {routes.map((route) => (
              <li key={route}>
                <code>{route}</code>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </section>
  );
}
```

- [ ] **Step 6: Create the app component**

Create `apps/mission-control-next/src/__testbench__/ui/TestbenchApp.tsx`:

```tsx
import { useMemo, useState } from "react";
import { ConfirmModal } from "@goatcitadel/mission-control-shared/components/ConfirmModal";
import { EmptyState, ErrorState, NoticeBanner } from "@next/features/native-routes/primitives";
import { domainLabel } from "../catalog/domains";
import type { TestbenchEnv } from "../env";
import { checkPermission } from "../runner/policy";
import { buildMarkdownReport } from "../runner/report";
import { countStatuses, recordFor } from "../runner/state";
import type { CheckDef } from "../runner/types";
import type { TargetInfo } from "../gateway-target/detect-target";
import type { TargetRequest } from "../gateway-target/resolve-target";
import { AreaRail } from "./AreaRail";
import { CheckDrawer } from "./CheckDrawer";
import { CheckList } from "./CheckList";
import { FilterBar } from "./FilterBar";
import { DEFAULT_FILTERS, filterChecks, summarizeDomains, type CheckFilters } from "./filters";
import { describeRunEnd } from "./status-display";
import { TopBar } from "./TopBar";
import { UncoveredRoutes } from "./UncoveredRoutes";
import {
  DEFAULT_TESTBENCH_DEPS,
  useTestbench,
  type ReadyLoad,
  type TestbenchController,
  type TestbenchDeps,
} from "./use-testbench";

type TabId = "console" | "uncovered";

export interface TestbenchAppProps {
  readonly targetRequest: TargetRequest;
  readonly env: TestbenchEnv;
  readonly deps?: TestbenchDeps;
}

export function TestbenchApp({ targetRequest, env, deps = DEFAULT_TESTBENCH_DEPS }: TestbenchAppProps) {
  const bench = useTestbench(targetRequest, env, deps);
  if (bench.load.phase === "loading") {
    return (
      <main className="testbench-shell">
        <EmptyState title="Connecting to the gateway…" />
      </main>
    );
  }
  if (bench.load.phase === "blocked") {
    return (
      <main className="testbench-shell">
        <ErrorState title={bench.load.title} description={bench.load.detail} />
      </main>
    );
  }
  return <ReadyView bench={bench} load={bench.load} />;
}

function ReadyView({ bench, load }: { readonly bench: TestbenchController; readonly load: ReadyLoad }) {
  const [tab, setTab] = useState<TabId>("console");
  const [filters, setFilters] = useState<CheckFilters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [pendingExternal, setPendingExternal] = useState<CheckDef | undefined>(undefined);
  const [copyNotice, setCopyNotice] = useState<string | undefined>(undefined);
  const { runState, options } = bench;
  const visible = useMemo(() => filterChecks(load.checks, runState, filters), [load.checks, runState, filters]);
  const domains = useMemo(() => summarizeDomains(load.checks, runState, domainLabel), [load.checks, runState]);
  const counts = useMemo(() => countStatuses(runState, load.checks.map((check) => check.id)), [runState, load.checks]);
  const selected = load.checks.find((check) => check.id === selectedId);

  const requestRun = (check: CheckDef) => {
    if (check.tier === "external" && !options.confirmedExternalIds.has(check.id)) {
      setPendingExternal(check);
      return;
    }
    bench.run([check.id]);
  };
  // External checks stay clickable before confirmation: clicking opens the confirmation dialog.
  const permissionOf = (check: CheckDef) =>
    checkPermission(check, load.target, {
      ...options,
      confirmedExternalIds: new Set([...options.confirmedExternalIds, check.id]),
    });
  const confirmExternal = () => {
    if (pendingExternal) {
      bench.run([pendingExternal.id], pendingExternal.id);
    }
    setPendingExternal(undefined);
  };
  const copyReport = () => {
    const markdown = buildMarkdownReport({
      target: load.target,
      coverage: bench.coverage,
      checks: load.checks,
      state: runState,
      generatedAt: new Date().toISOString(),
    });
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) {
      setCopyNotice("Copy failed: this browser does not expose the clipboard.");
      return;
    }
    clipboard.writeText(markdown).then(
      () => setCopyNotice("Report copied as Markdown."),
      () => setCopyNotice("Copy failed: the browser blocked clipboard access."),
    );
  };

  return (
    <main className="testbench-shell">
      <TopBar
        target={load.target}
        coverage={bench.coverage}
        manifestError={load.manifestError}
        running={runState.running}
        allowHost={options.allowHost}
        copyNotice={copyNotice}
        onAllowHostChange={bench.setAllowHost}
        onRunAll={() => bench.run(load.checks.map((check) => check.id))}
        onStop={bench.stop}
        onCopyReport={copyReport}
      />
      {runState.banner ? <NoticeBanner tone="error" message={runState.banner} /> : null}
      <div className="testbench-tabs" role="tablist" aria-label="Test bench views">
        <button type="button" role="tab" aria-selected={tab === "console"} onClick={() => setTab("console")}>
          Live console
        </button>
        <button type="button" role="tab" aria-selected={tab === "uncovered"} onClick={() => setTab("uncovered")}>
          {`Uncovered routes (${bench.coverage ? bench.coverage.uncovered.length : "unavailable"})`}
        </button>
      </div>
      {tab === "console" ? (
        <>
          <FilterBar filters={filters} counts={counts} onChange={setFilters} />
          <div className="testbench-panes">
            <AreaRail domains={domains} selected={filters.domain} onSelect={(domain) => setFilters({ ...filters, domain })} />
            <CheckList
              checks={visible}
              state={runState}
              selectedId={selectedId}
              running={runState.running}
              onSelect={setSelectedId}
              onRun={requestRun}
              permissionOf={permissionOf}
            />
            <CheckDrawer
              check={selected}
              record={selected ? recordFor(runState, selected.id) : undefined}
              onClose={() => setSelectedId(undefined)}
            />
          </div>
        </>
      ) : (
        <UncoveredRoutes coverage={bench.coverage} labelFor={domainLabel} />
      )}
      <p className="testbench-sr-only" role="status" aria-live="polite">
        {describeRunEnd(runState, counts)}
      </p>
      <ConfirmModal
        open={pendingExternal !== undefined}
        title="Run an external check?"
        message={pendingExternal ? externalConfirmMessage(pendingExternal, load.target) : ""}
        confirmLabel="Run it"
        onConfirm={confirmExternal}
        onCancel={() => setPendingExternal(undefined)}
      />
    </main>
  );
}

function externalConfirmMessage(check: CheckDef, target: TargetInfo): string {
  const where = target.kind === "sandbox" ? "the sandbox gateway" : `the real gateway at ${target.origin}`;
  return [`“${check.title}” runs against ${where} and leaves this machine.`, check.description]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}
```

- [ ] **Step 7: Create the stylesheet**

Create `apps/mission-control-next/src/__testbench__/ui/testbench.css`:

```css
.testbench-shell {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-height: 100vh;
  padding: 1rem;
  background: var(--bg-app);
  color: var(--fg-primary);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
}

.testbench-shell :focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.testbench-topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.25rem;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  background: var(--bg-surface-1);
}

.testbench-target,
.testbench-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.testbench-meta {
  color: var(--fg-muted);
  font-size: var(--text-xs);
}

.testbench-warning {
  color: var(--warning);
}

.testbench-link {
  color: var(--brand);
  font-size: var(--text-xs);
}

.testbench-coverage {
  display: flex;
  flex: 1 1 12rem;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 10rem;
}

.testbench-progress {
  width: 100%;
  height: 0.375rem;
  accent-color: var(--brand);
}

.testbench-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  font-size: var(--text-xs);
}

.testbench-tabs {
  display: flex;
  gap: 1rem;
  border-bottom: 1px solid var(--border-subtle);
}

.testbench-tabs button {
  padding: 0.5rem 0;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--fg-muted);
  font-family: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
}

.testbench-tabs button[aria-selected="true"] {
  border-bottom-color: var(--brand);
  color: var(--fg-primary);
  font-weight: 600;
}

.testbench-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.375rem;
}

.testbench-chip {
  padding: 0.125rem 0.625rem;
  border: 1px solid var(--border-default);
  border-radius: var(--r-pill);
  background: var(--bg-surface-1);
  color: var(--fg-secondary);
  font-family: inherit;
  font-size: var(--text-xs);
  cursor: pointer;
}

.testbench-chip[aria-pressed="true"] {
  border-color: var(--brand);
  color: var(--fg-primary);
}

.testbench-divider {
  width: 1px;
  height: 1.25rem;
  background: var(--border-subtle);
}

.testbench-search {
  flex: 1 1 12rem;
  min-width: 10rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--border-default);
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  color: var(--fg-primary);
  font-family: inherit;
  font-size: var(--text-sm);
}

.testbench-panes {
  display: grid;
  grid-template-columns: 13rem minmax(0, 1fr) 22rem;
  min-height: 28rem;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-md);
  background: var(--bg-surface-1);
}

.testbench-rail {
  overflow-y: auto;
  border-right: 1px solid var(--border-subtle);
  background: var(--bg-surface-2);
}

.testbench-rail-select {
  display: none;
}

.testbench-rail-list,
.testbench-list ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.testbench-rail-list button {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.375rem 0.75rem;
  border: 0;
  background: none;
  color: var(--fg-secondary);
  font-family: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.testbench-rail-list button[aria-current="true"] {
  background: var(--bg-surface-3);
  color: var(--fg-primary);
  font-weight: 600;
}

.testbench-list {
  min-width: 0;
  overflow-y: auto;
}

.testbench-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.25rem 0.5rem;
  padding: 0.25rem 0.75rem;
  border-bottom: 1px solid var(--border-hairline);
}

.testbench-row[data-selected="true"] {
  background: var(--bg-surface-3);
}

.testbench-row-main {
  display: grid;
  grid-template-columns: 7rem minmax(0, 1fr) 4.5rem 4rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
  border: 0;
  background: none;
  color: inherit;
  font-family: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.testbench-row-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.testbench-tier {
  justify-self: start;
  padding: 0 0.375rem;
  border: 1px solid var(--border-default);
  border-radius: var(--r-xs);
  color: var(--fg-secondary);
  font-size: var(--text-2xs);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.testbench-duration {
  text-align: right;
}

.testbench-reason {
  grid-column: 1 / -1;
}

.testbench-more {
  margin: 0.5rem 0.75rem;
}

.testbench-drawer {
  overflow-y: auto;
  padding: 0.75rem 1rem;
  border-left: 1px solid var(--border-subtle);
  background: var(--bg-surface-1);
}

.testbench-drawer-header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 0.5rem;
}

.testbench-drawer h2 {
  margin: 0;
  font-size: var(--text-md);
}

.testbench-drawer h3 {
  margin: 0.75rem 0 0.25rem;
  color: var(--fg-muted);
  font-size: var(--text-xs);
  text-transform: uppercase;
}

.testbench-steps {
  margin: 0.5rem 0;
  padding-left: 1.25rem;
}

.testbench-routes {
  margin: 0;
  padding-left: 1.25rem;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.testbench-raw pre {
  max-height: 20rem;
  overflow: auto;
  padding: 0.5rem;
  border-radius: var(--r-sm);
  background: var(--bg-inset);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  white-space: pre-wrap;
  word-break: break-word;
}

.testbench-uncovered {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.testbench-uncovered h2 {
  margin: 0.5rem 0 0;
  font-size: var(--text-md);
}

.testbench-uncovered code {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.testbench-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 1023px) {
  .testbench-panes {
    grid-template-columns: minmax(0, 1fr);
  }

  .testbench-rail {
    padding: 0.5rem;
    border-right: 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .testbench-rail-list {
    display: none;
  }

  .testbench-rail-select {
    display: block;
    width: 100%;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--border-default);
    border-radius: var(--r-sm);
    background: var(--bg-inset);
    color: var(--fg-primary);
    font-family: inherit;
    font-size: var(--text-sm);
  }

  .testbench-row-main {
    grid-template-columns: 6rem minmax(0, 1fr);
  }

  .testbench-row-main .testbench-tier,
  .testbench-row-main .testbench-duration {
    display: none;
  }

  .testbench-drawer {
    position: fixed;
    inset: auto 0 0 0;
    z-index: calc(var(--z-modal) - 1);
    max-height: 60vh;
    border-top: 1px solid var(--border-default);
    border-left: 0;
    box-shadow: 0 -8px 24px rgb(0 0 0 / 0.35);
  }

  .testbench-drawer-empty {
    display: none;
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__'`
Expected: PASS for every file under `src/__testbench__`.

- [ ] **Step 9: Typecheck, lint, and design contracts**

Run: `pnpm --filter @goatcitadel/mission-control-next typecheck`
Expected: exit code 0.

Run: `pnpm exec eslint apps/mission-control-next/src/__testbench__ --max-warnings 0`
Expected: exit code 0.

Run: `pnpm --filter @goatcitadel/mission-control-next build`
Expected: exit code 0. (The budgets step of `perf:check` reads `dist/index.html`.)

Run: `pnpm --filter @goatcitadel/mission-control-next perf:check`
Expected: exit code 0. A typography, breakpoint, button, or icon-sizing failure names the file and line; fix it in `testbench.css` or the component, never by editing the check.

- [ ] **Step 10: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/testbench.html apps/mission-control-next/src/__testbench__/main.tsx apps/mission-control-next/src/__testbench__/main.test.ts apps/mission-control-next/src/__testbench__/ui/mount.tsx apps/mission-control-next/src/__testbench__/ui/TestbenchApp.tsx apps/mission-control-next/src/__testbench__/ui/TestbenchApp.test.tsx apps/mission-control-next/src/__testbench__/ui/TopBar.tsx apps/mission-control-next/src/__testbench__/ui/FilterBar.tsx apps/mission-control-next/src/__testbench__/ui/AreaRail.tsx apps/mission-control-next/src/__testbench__/ui/CheckList.tsx apps/mission-control-next/src/__testbench__/ui/CheckDrawer.tsx apps/mission-control-next/src/__testbench__/ui/UncoveredRoutes.tsx apps/mission-control-next/src/__testbench__/ui/testbench.css
git commit -m "feat(testbench): add the dev-only test bench page"
```

---

### Task 12: Provider and capability checks

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/catalog/providers.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/capabilities.ts`
- Modify: `apps/mission-control-next/src/__testbench__/catalog/index.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/providers.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/capabilities.test.ts`

**Interfaces:**
- Consumes: `fetchLlmConfig(): Promise<{ activeProviderId: string; activeModel: string; providers: Array<{ providerId: string }>; revision: number }>`, `fetchLlmModels(providerId?): Promise<{ items: unknown[]; source: "live" | "template_fallback" | "error_fallback"; warning?: string }>`, `createLlmChatCompletion({ providerId?, model?, messages, max_tokens? }): Promise<{ choices?: Array<{ message?: { content?: string } }> }>` from `@goatcitadel/mission-control-shared/api/platform`; `fetchCapabilityCatalog(scope: "inspectable" | "callable"): Promise<{ scope; items: Array<{ capabilityId: string; kind: string; callable: boolean }> }>`, `fetchCapabilityCatalogDriftMetrics(workspaceId?): Promise<{ callableSubsetValid: boolean; orphanCallableCapabilityIds: string[] }>` from `.../api/capabilities`; `exerciseProvider` (Task 9).
- Produces: `providerChecks`, `capabilityChecks`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/catalog/providers.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { providerChecks } from "./providers";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  fetchLlmConfig: vi.fn(),
  fetchLlmModels: vi.fn(),
  createLlmChatCompletion: vi.fn(),
  exerciseProvider: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({ request: mocks.request }));
vi.mock("@goatcitadel/mission-control-shared/api/platform", () => ({
  fetchLlmConfig: mocks.fetchLlmConfig,
  fetchLlmModels: mocks.fetchLlmModels,
  createLlmChatCompletion: mocks.createLlmChatCompletion,
}));
vi.mock("./dev-verification", () => ({ exerciseProvider: mocks.exerciseProvider }));

const CONFIG = {
  activeProviderId: "verification-stub",
  activeModel: "verification-stub-chat",
  providers: [{ providerId: "verification-stub" }],
  revision: 1,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.fetchLlmConfig.mockResolvedValue(CONFIG);
});

function run(id: string) {
  return findCheck(providerChecks, id).run(makeTestContext());
}

describe("provider checks", () => {
  it("lists configured providers and fails when there are none", async () => {
    mocks.request.mockResolvedValueOnce({ items: [{ providerId: "verification-stub" }] });
    await expect(run("llm.providers")).resolves.toMatchObject({ status: "pass", summary: "1 provider(s): verification-stub." });
    mocks.request.mockResolvedValueOnce({ items: [] });
    await expect(run("llm.providers")).rejects.toThrow("No providers are configured.");
  });

  it("requires the active provider to be in the provider list", async () => {
    await expect(run("llm.config")).resolves.toMatchObject({ status: "pass" });
    mocks.fetchLlmConfig.mockResolvedValueOnce({ ...CONFIG, providers: [] });
    await expect(run("llm.config")).rejects.toThrow("is not in the provider list");
  });

  it("sends a completion through the active provider", async () => {
    mocks.createLlmChatCompletion.mockResolvedValueOnce({ choices: [{ index: 0, message: { content: "Verification stub reply." } }] });
    await expect(run("llm.completion")).resolves.toMatchObject({
      status: "pass",
      summary: expect.stringContaining("Verification stub reply."),
    });
    expect(mocks.createLlmChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "verification-stub", model: "verification-stub-chat" }),
    );
    mocks.createLlmChatCompletion.mockResolvedValueOnce({ choices: [] });
    await expect(run("llm.completion")).rejects.toThrow("empty completion");
  });

  it("requires a live model catalog", async () => {
    mocks.fetchLlmModels.mockResolvedValueOnce({ items: [{}, {}], source: "live" });
    await expect(run("llm.model-catalog")).resolves.toMatchObject({ summary: "2 models listed live by verification-stub." });
    mocks.fetchLlmModels.mockResolvedValueOnce({ items: [], source: "template_fallback", warning: "Catalog unreachable." });
    await expect(run("llm.model-catalog")).rejects.toThrow("template_fallback: Catalog unreachable.");
  });

  it("reports the provider exercise result", async () => {
    mocks.exerciseProvider.mockResolvedValueOnce({ ok: true, model: "verification-stub-chat", elapsedMs: 12 });
    await expect(run("llm.provider-exercise")).resolves.toMatchObject({ summary: "verification-stub-chat answered in 12 ms." });
    mocks.exerciseProvider.mockResolvedValueOnce({ ok: false, error: "401 from provider" });
    await expect(run("llm.provider-exercise")).rejects.toThrow("401 from provider");
  });

  it("allowlists only the network checks for the real gateway", () => {
    expect(providerChecks.filter((check) => check.realSafe === true).map((check) => check.id)).toEqual([
      "llm.model-catalog",
      "llm.provider-exercise",
    ]);
  });
});
```

Create `apps/mission-control-next/src/__testbench__/catalog/capabilities.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { capabilityChecks } from "./capabilities";

const mocks = vi.hoisted(() => ({
  fetchCapabilityCatalog: vi.fn(),
  fetchCapabilityCatalogDriftMetrics: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => mocks);

const TOOL = { capabilityId: "tool:fs.read", kind: "tool", callable: true };
const CANDIDATE = { capabilityId: "candidate:c1:v1", kind: "candidate_skill", callable: false };
const HEALTHY_METRICS = { callableSubsetValid: true, orphanCallableCapabilityIds: [] };

function catalogs(callable: unknown[], inspectable: unknown[]) {
  mocks.fetchCapabilityCatalog.mockImplementation(async (scope: string) => ({
    scope,
    items: scope === "callable" ? callable : inspectable,
  }));
}

beforeEach(() => {
  mocks.fetchCapabilityCatalog.mockReset();
  mocks.fetchCapabilityCatalogDriftMetrics.mockReset();
  mocks.fetchCapabilityCatalogDriftMetrics.mockResolvedValue(HEALTHY_METRICS);
});

function run() {
  return findCheck(capabilityChecks, "capabilities.callable-invariants").run(makeTestContext());
}

describe("capability invariants", () => {
  it("passes when only active, inspectable entries are callable", async () => {
    catalogs([TOOL], [TOOL, CANDIDATE]);
    await expect(run()).resolves.toMatchObject({
      status: "pass",
      summary: "1 callable of 2 inspectable; no inactive entry is callable.",
    });
  });

  it("fails when a candidate is callable", async () => {
    catalogs([TOOL, { ...CANDIDATE, callable: true }], [TOOL, CANDIDATE]);
    await expect(run()).rejects.toThrow("Inactive candidates or proposals are callable: candidate:c1:v1.");
  });

  it("fails when a callable entry is missing from the inspectable catalog", async () => {
    catalogs([TOOL], [CANDIDATE]);
    await expect(run()).rejects.toThrow("missing from the inspectable catalog: tool:fs.read");
  });

  it("fails when the drift metrics report an invalid subset", async () => {
    catalogs([TOOL], [TOOL]);
    mocks.fetchCapabilityCatalogDriftMetrics.mockResolvedValueOnce({ ...HEALTHY_METRICS, callableSubsetValid: false });
    await expect(run()).rejects.toThrow("not a valid subset");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/providers.test.ts' 'src/__testbench__/catalog/capabilities.test.ts'`
Expected: FAIL, because `./providers` and `./capabilities` do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/catalog/providers.ts`:

```ts
import { request } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  createLlmChatCompletion,
  fetchLlmConfig,
  fetchLlmModels,
} from "@goatcitadel/mission-control-shared/api/platform";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { exerciseProvider } from "./dev-verification";

interface ProviderSummary {
  readonly providerId?: string;
}

const COMPLETION_PROMPT = "Reply with one word: ready.";

export const providerChecks: readonly CheckDef[] = [
  {
    id: "llm.providers",
    kind: "probe",
    domain: "llm",
    title: "Configured providers",
    tier: "read",
    routes: ["GET /api/v1/llm/providers"],
    async run(ctx) {
      const body = await request<{ readonly items?: readonly ProviderSummary[] }>("/api/v1/llm/providers", {
        signal: ctx.signal,
      });
      const ids = (body.items ?? []).map((provider) => provider.providerId ?? "");
      ensure(ids.length > 0, "No providers are configured.", body);
      ensure(ids.every((id) => id !== ""), "A provider has no id.", body);
      return pass(`${ids.length} provider(s): ${ids.join(", ")}.`);
    },
  },
  {
    id: "llm.config",
    kind: "probe",
    domain: "llm",
    title: "Active provider and model",
    tier: "read",
    routes: ["GET /api/v1/llm/config"],
    async run() {
      const config = await fetchLlmConfig();
      ensure(config.activeProviderId, "No active provider is set.", config);
      ensure(config.activeModel, "No active model is set.", config);
      ensure(
        config.providers.some((provider) => provider.providerId === config.activeProviderId),
        `Active provider ${config.activeProviderId} is not in the provider list.`,
        config,
      );
      return pass(`Active: ${config.activeProviderId} / ${config.activeModel}.`);
    },
  },
  {
    id: "llm.completion",
    kind: "probe",
    domain: "llm",
    title: "Chat completion through the active provider",
    tier: "mutate",
    description: "Records a model-usage entry. In the sandbox the active provider is the deterministic stub.",
    routes: ["GET /api/v1/llm/config", "POST /api/v1/llm/chat-completions"],
    async run() {
      const config = await fetchLlmConfig();
      const reply = await createLlmChatCompletion({
        providerId: config.activeProviderId,
        model: config.activeModel,
        messages: [{ role: "user", content: COMPLETION_PROMPT }],
        max_tokens: 16,
      });
      const text = String(reply.choices?.[0]?.message?.content ?? "").trim();
      ensure(text !== "", "The provider returned an empty completion.", reply);
      return pass(`${config.activeModel} answered: “${text.slice(0, 80)}”.`, reply);
    },
  },
  {
    id: "llm.model-catalog",
    kind: "probe",
    domain: "llm",
    title: "Live model catalog",
    tier: "external",
    realSafe: true,
    description:
      "Asks the active provider's API for its model list. Reaches the provider over the network, spends no tokens, and saves nothing. The sandbox stub may not serve a catalog.",
    routes: ["GET /api/v1/llm/config", "GET /api/v1/llm/models"],
    async run() {
      const config = await fetchLlmConfig();
      const catalog = await fetchLlmModels(config.activeProviderId);
      const warning = typeof catalog.warning === "string" && catalog.warning !== "" ? `: ${catalog.warning}` : "";
      ensure(catalog.source === "live", `The catalog came from ${catalog.source}${warning}.`, catalog);
      return pass(`${catalog.items.length} models listed live by ${config.activeProviderId}.`);
    },
  },
  {
    id: "llm.provider-exercise",
    kind: "probe",
    domain: "llm",
    title: "Provider exercise (simple prompt)",
    tier: "external",
    realSafe: true,
    description: "Sends one short prompt through the active provider. Spends tokens and records model-usage entries on this gateway.",
    routes: ["POST /api/v1/dev/verification/provider-exercise"],
    async run() {
      const result = await exerciseProvider({ scenario: "simple" });
      ensure(result.ok, `The provider exercise failed: ${result.error ?? "no error message"}.`, result);
      return pass(`${result.model ?? "The model"} answered in ${result.elapsedMs ?? "?"} ms.`, result);
    },
  },
];
```

Create `apps/mission-control-next/src/__testbench__/catalog/capabilities.ts`:

```ts
import {
  fetchCapabilityCatalog,
  fetchCapabilityCatalogDriftMetrics,
} from "@goatcitadel/mission-control-shared/api/capabilities";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";

const INACTIVE_KINDS: ReadonlySet<string> = new Set(["candidate_skill", "proposal"]);

export const capabilityChecks: readonly CheckDef[] = [
  {
    id: "capabilities.callable-invariants",
    kind: "journey",
    domain: "capabilities",
    title: "Callable catalog invariants",
    tier: "read",
    routes: ["GET /api/v1/capabilities/catalog", "GET /api/v1/capabilities/catalog-metrics"],
    steps: ["Read callable catalog", "Read inspectable catalog", "Read drift metrics"],
    async run(ctx) {
      const callable = await ctx.step("Read callable catalog", () => fetchCapabilityCatalog("callable"));
      const inspectable = await ctx.step("Read inspectable catalog", () => fetchCapabilityCatalog("inspectable"));
      const metrics = await ctx.step("Read drift metrics", () => fetchCapabilityCatalogDriftMetrics());
      const notCallable = callable.items.filter((item) => item.callable !== true).map((item) => item.capabilityId);
      ensure(notCallable.length === 0, `The callable catalog lists entries marked not callable: ${notCallable.join(", ")}.`, notCallable);
      const inactive = callable.items.filter((item) => INACTIVE_KINDS.has(item.kind)).map((item) => item.capabilityId);
      ensure(inactive.length === 0, `Inactive candidates or proposals are callable: ${inactive.join(", ")}.`, inactive);
      const inspectableIds = new Set(inspectable.items.map((item) => item.capabilityId));
      const orphans = callable.items
        .filter((item) => !inspectableIds.has(item.capabilityId))
        .map((item) => item.capabilityId);
      ensure(orphans.length === 0, `Callable entries are missing from the inspectable catalog: ${orphans.join(", ")}.`, orphans);
      ensure(metrics.callableSubsetValid, "The drift metrics report the callable catalog is not a valid subset.", metrics);
      ensure(metrics.orphanCallableCapabilityIds.length === 0, "The drift metrics report orphan callable capabilities.", metrics);
      return pass(`${callable.items.length} callable of ${inspectable.items.length} inspectable; no inactive entry is callable.`);
    },
  },
];
```

Replace `apps/mission-control-next/src/__testbench__/catalog/index.ts` with:

```ts
import type { CheckDef } from "../runner/types";
import { capabilityChecks } from "./capabilities";
import { healthChecks } from "./health";
import { providerChecks } from "./providers";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [...healthChecks, ...providerChecks, ...capabilityChecks];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog'`
Expected: PASS, including `integrity.test.ts` over the new checks.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/catalog/providers.ts apps/mission-control-next/src/__testbench__/catalog/providers.test.ts apps/mission-control-next/src/__testbench__/catalog/capabilities.ts apps/mission-control-next/src/__testbench__/catalog/capabilities.test.ts apps/mission-control-next/src/__testbench__/catalog/index.ts
git commit -m "feat(testbench): check providers and capability invariants"
```

---

### Task 13: Chat session and attachment checks

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/catalog/context.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/chat-sessions.ts`
- Modify: `apps/mission-control-next/src/__testbench__/catalog/index.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/chat-sessions.test.ts`

**Interfaces:**
- Consumes: `createChatSession(input?: { workspaceId?; title? }): Promise<ChatSessionRecord>` (fields `sessionId`, `revision`, `title?`, `lifecycleStatus: "active" | "archived"`), `updateChatSession(sessionId, { expectedRevision, title? })`, `archiveChatSession(sessionId, expectedRevision)`, `restoreChatSession(sessionId, expectedRevision)`, `uploadChatAttachment({ sessionId, file })` and `fetchChatAttachment(attachmentId)` (fields `attachmentId`, `sha256`, `sizeBytes`) from `@goatcitadel/mission-control-shared/api/chat`; `CheckAssertionError`, `ensure`, `pass` (Task 4).
- Produces: `ScratchSession`, `requireWorkspace(ctx)`, `createScratchSession(ctx, purpose)`, `sha256Hex(text)`; `chatSessionChecks`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/catalog/chat-sessions.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { chatSessionChecks } from "./chat-sessions";
import { sha256Hex } from "./context";

const mocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  updateChatSession: vi.fn(),
  archiveChatSession: vi.fn(),
  restoreChatSession: vi.fn(),
  uploadChatAttachment: vi.fn(),
  fetchChatAttachment: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => mocks);

const ATTACHMENT_TEXT = "GoatCitadel test bench attachment.\n";
const SESSION = { sessionId: "s-1", revision: 1, lifecycleStatus: "active", title: "Test bench: lifecycle" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createChatSession.mockResolvedValue(SESSION);
});

describe("sha256Hex", () => {
  it("matches the standard test vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("session lifecycle", () => {
  it("creates, renames, archives, and restores with the latest revision each time", async () => {
    const renamedTitle = "Test bench: lifecycle (renamed)";
    mocks.updateChatSession.mockResolvedValueOnce({ ...SESSION, title: renamedTitle, revision: 2 });
    mocks.archiveChatSession.mockResolvedValueOnce({ ...SESSION, title: renamedTitle, revision: 3, lifecycleStatus: "archived" });
    mocks.restoreChatSession.mockResolvedValueOnce({ ...SESSION, title: renamedTitle, revision: 4 });
    const check = findCheck(chatSessionChecks, "chat.session-lifecycle");
    await expect(check.run(makeTestContext())).resolves.toMatchObject({ status: "pass" });
    expect(mocks.createChatSession).toHaveBeenCalledWith({ workspaceId: "ws-testbench", title: "Test bench: lifecycle" });
    expect(mocks.updateChatSession).toHaveBeenCalledWith("s-1", { expectedRevision: 1, title: renamedTitle });
    expect(mocks.archiveChatSession).toHaveBeenCalledWith("s-1", 2);
    expect(mocks.restoreChatSession).toHaveBeenCalledWith("s-1", 3);
  });

  it("fails when the archive does not archive", async () => {
    mocks.updateChatSession.mockResolvedValueOnce({ ...SESSION, title: "Test bench: lifecycle (renamed)", revision: 2 });
    mocks.archiveChatSession.mockResolvedValueOnce({ ...SESSION, revision: 3 });
    await expect(findCheck(chatSessionChecks, "chat.session-lifecycle").run(makeTestContext())).rejects.toThrow(
      "The session did not archive.",
    );
  });

  it("needs the seeded workspace", async () => {
    await expect(
      findCheck(chatSessionChecks, "chat.session-lifecycle").run(makeTestContext({ workspaceId: undefined })),
    ).rejects.toThrow("needs the seeded test workspace");
  });
});

describe("attachment round trip", () => {
  it("passes when the stored SHA-256 and size match the upload", async () => {
    const sha256 = await sha256Hex(ATTACHMENT_TEXT);
    const stored = { attachmentId: "att-1", sha256, sizeBytes: new TextEncoder().encode(ATTACHMENT_TEXT).byteLength };
    mocks.uploadChatAttachment.mockResolvedValueOnce(stored);
    mocks.fetchChatAttachment.mockResolvedValueOnce(stored);
    await expect(findCheck(chatSessionChecks, "chat.attachment-roundtrip").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
    });
    const upload = mocks.uploadChatAttachment.mock.calls[0]?.[0] as { sessionId: string; file: File };
    expect(upload.sessionId).toBe("s-1");
    expect(await upload.file.text()).toBe(ATTACHMENT_TEXT);
  });

  it("fails when the gateway records a different SHA-256", async () => {
    mocks.uploadChatAttachment.mockResolvedValueOnce({ attachmentId: "att-1", sha256: "0".repeat(64), sizeBytes: 35 });
    await expect(findCheck(chatSessionChecks, "chat.attachment-roundtrip").run(makeTestContext())).rejects.toThrow(
      "different SHA-256",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/chat-sessions.test.ts'`
Expected: FAIL, because `./chat-sessions` and `./context` do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/catalog/context.ts`:

```ts
import { createChatSession } from "@goatcitadel/mission-control-shared/api/chat";
import { CheckAssertionError } from "../runner/assert";
import type { CheckContext } from "../runner/types";

export type ScratchSession = Awaited<ReturnType<typeof createChatSession>>;

export function requireWorkspace(ctx: CheckContext): string {
  if (!ctx.workspaceId) {
    throw new CheckAssertionError("This check needs the seeded test workspace, which exists only in the verified sandbox.");
  }
  return ctx.workspaceId;
}

/** Each check works in its own session so seeded turns never collide. */
export function createScratchSession(ctx: CheckContext, purpose: string): Promise<ScratchSession> {
  return createChatSession({ workspaceId: requireWorkspace(ctx), title: `Test bench: ${purpose}` });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
```

Create `apps/mission-control-next/src/__testbench__/catalog/chat-sessions.ts`:

```ts
import {
  archiveChatSession,
  fetchChatAttachment,
  restoreChatSession,
  updateChatSession,
  uploadChatAttachment,
} from "@goatcitadel/mission-control-shared/api/chat";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { createScratchSession, sha256Hex } from "./context";

const ATTACHMENT_TEXT = "GoatCitadel test bench attachment.\n";

export const chatSessionChecks: readonly CheckDef[] = [
  {
    id: "chat.session-lifecycle",
    kind: "journey",
    domain: "chat",
    title: "Session lifecycle",
    tier: "mutate",
    needsWorkspace: true,
    routes: [
      "POST /api/v1/chat/sessions",
      "PATCH /api/v1/chat/sessions/:sessionId",
      "POST /api/v1/chat/sessions/:sessionId/archive",
      "POST /api/v1/chat/sessions/:sessionId/restore",
    ],
    steps: ["Create session", "Rename session", "Archive session", "Restore session"],
    async run(ctx) {
      const created = await ctx.step("Create session", () => createScratchSession(ctx, "lifecycle"));
      ensure(created.lifecycleStatus === "active", "A new session is not active.", created);
      const title = `${created.title ?? "Test bench session"} (renamed)`;
      const renamed = await ctx.step("Rename session", () =>
        updateChatSession(created.sessionId, { expectedRevision: created.revision, title }),
      );
      ensure(renamed.title === title && renamed.revision > created.revision, "The rename did not apply with a new revision.", renamed);
      const archived = await ctx.step("Archive session", () => archiveChatSession(created.sessionId, renamed.revision));
      ensure(archived.lifecycleStatus === "archived", "The session did not archive.", archived);
      const restored = await ctx.step("Restore session", () => restoreChatSession(created.sessionId, archived.revision));
      ensure(restored.lifecycleStatus === "active", "The session did not restore.", restored);
      return pass(`Session ${created.sessionId} went through create, rename, archive, and restore.`);
    },
  },
  {
    id: "chat.attachment-roundtrip",
    kind: "journey",
    domain: "chat",
    title: "Attachment upload and SHA-256 round trip",
    tier: "mutate",
    needsWorkspace: true,
    routes: ["POST /api/v1/chat/sessions", "POST /api/v1/chat/attachments", "GET /api/v1/chat/attachments/:attachmentId"],
    steps: ["Create session", "Upload attachment", "Read attachment back"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "attachment"));
      const expectedSha = await sha256Hex(ATTACHMENT_TEXT);
      const expectedBytes = new TextEncoder().encode(ATTACHMENT_TEXT).byteLength;
      const file = new File([ATTACHMENT_TEXT], "testbench.txt", { type: "text/plain" });
      const uploaded = await ctx.step("Upload attachment", () => uploadChatAttachment({ sessionId: session.sessionId, file }));
      ensure(uploaded.sha256 === expectedSha, "The gateway recorded a different SHA-256 than the uploaded bytes.", uploaded);
      const fetched = await ctx.step("Read attachment back", () => fetchChatAttachment(uploaded.attachmentId));
      ensure(
        fetched.sha256 === expectedSha && fetched.sizeBytes === expectedBytes,
        "The stored attachment does not match the upload.",
        fetched,
      );
      return pass(`Stored ${fetched.sizeBytes} bytes with a matching SHA-256.`, fetched);
    },
  },
];
```

Replace `apps/mission-control-next/src/__testbench__/catalog/index.ts` with:

```ts
import type { CheckDef } from "../runner/types";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { healthChecks } from "./health";
import { providerChecks } from "./providers";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog'`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/catalog/context.ts apps/mission-control-next/src/__testbench__/catalog/chat-sessions.ts apps/mission-control-next/src/__testbench__/catalog/chat-sessions.test.ts apps/mission-control-next/src/__testbench__/catalog/index.ts
git commit -m "feat(testbench): check chat session lifecycle and attachments"
```

---

### Task 14: Chat turn checks (streamed reply, cancel, user input)

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/catalog/chat-turns.ts`
- Modify: `apps/mission-control-next/src/__testbench__/catalog/index.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/chat-turns.test.ts`

**Interfaces:**
- Consumes: `preflightChatRoute(sessionId, { action: "send", content }): Promise<RoutingPreflightResult>` (fields `blockedReason?`, `decision: { effectiveProviderId?, effectiveModel?, ... }`), `streamAgentChatMessage(sessionId, input, onChunk, { signal? }): Promise<void>` (chunks discriminated by `type`; `delta` chunks carry `delta: string`; a `done` chunk ends the turn), `cancelChatTurn(sessionId, turnId, cancelledBy?)` → `{ cancelled: boolean; trace: { status } }`, `answerChatUserInputPrompt(sessionId, turnId, promptId, { response: { kind: "single_select", optionId } })` → `{ ok: true; resumed: boolean }`, `fetchChatThread(sessionId)` → `{ turns: Array<{ turnId; trace: { pendingUserInput? } }> }` from `.../api/chat`; `seedChatApprovalScenario`, `seedChatUserInputScenario` (Task 9); `createScratchSession`, `requireWorkspace` (Task 13).
- Produces: `chatTurnChecks`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/catalog/chat-turns.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { chatTurnChecks } from "./chat-turns";

const mocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  preflightChatRoute: vi.fn(),
  streamAgentChatMessage: vi.fn(),
  cancelChatTurn: vi.fn(),
  answerChatUserInputPrompt: vi.fn(),
  fetchChatThread: vi.fn(),
  seedChatApprovalScenario: vi.fn(),
  seedChatUserInputScenario: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  createChatSession: mocks.createChatSession,
  preflightChatRoute: mocks.preflightChatRoute,
  streamAgentChatMessage: mocks.streamAgentChatMessage,
  cancelChatTurn: mocks.cancelChatTurn,
  answerChatUserInputPrompt: mocks.answerChatUserInputPrompt,
  fetchChatThread: mocks.fetchChatThread,
}));
vi.mock("./dev-verification", () => ({
  seedChatApprovalScenario: mocks.seedChatApprovalScenario,
  seedChatUserInputScenario: mocks.seedChatUserInputScenario,
}));

const DECISION = { effectiveProviderId: "verification-stub", effectiveModel: "verification-stub-chat", fingerprint: "f" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createChatSession.mockResolvedValue({ sessionId: "s-1", revision: 1, lifecycleStatus: "active" });
  mocks.preflightChatRoute.mockResolvedValue({ decision: DECISION });
});

function run(id: string) {
  return findCheck(chatTurnChecks, id).run(makeTestContext());
}

describe("streamed reply", () => {
  it("sends with the preflight route decision and collects the streamed text", async () => {
    mocks.streamAgentChatMessage.mockImplementation(async (_sessionId: string, _input: unknown, onChunk: (chunk: unknown) => void) => {
      onChunk({ type: "delta", delta: "Verification " });
      onChunk({ type: "delta", delta: "stub reply." });
      onChunk({ type: "done" });
    });
    await expect(run("chat.stream-reply")).resolves.toMatchObject({
      status: "pass",
      summary: expect.stringContaining("Verification stub reply."),
    });
    expect(mocks.streamAgentChatMessage.mock.calls[0]?.[1]).toMatchObject({
      routeDecision: DECISION,
      providerId: "verification-stub",
      model: "verification-stub-chat",
    });
  });

  it("fails when routing is blocked", async () => {
    mocks.preflightChatRoute.mockResolvedValueOnce({ decision: DECISION, blockedReason: "provider_unavailable" });
    await expect(run("chat.stream-reply")).rejects.toThrow("Routing is blocked: provider_unavailable.");
    expect(mocks.streamAgentChatMessage).not.toHaveBeenCalled();
  });

  it("fails when the stream never sends done", async () => {
    mocks.streamAgentChatMessage.mockImplementation(async (_sessionId: string, _input: unknown, onChunk: (chunk: unknown) => void) => {
      onChunk({ type: "delta", delta: "partial" });
    });
    await expect(run("chat.stream-reply")).rejects.toThrow("never sent its done event");
  });
});

describe("cancel a waiting turn", () => {
  it("cancels the seeded turn", async () => {
    mocks.seedChatApprovalScenario.mockResolvedValueOnce({ sessionId: "s-1", workspaceId: "ws-testbench", turnId: "t-1" });
    mocks.cancelChatTurn.mockResolvedValueOnce({ cancelled: true, trace: { status: "cancelled" } });
    await expect(run("chat.cancel-waiting-turn")).resolves.toMatchObject({ status: "pass" });
    expect(mocks.cancelChatTurn).toHaveBeenCalledWith("s-1", "t-1", "testbench");
  });

  it("fails when the trace does not end cancelled", async () => {
    mocks.seedChatApprovalScenario.mockResolvedValueOnce({ sessionId: "s-1", workspaceId: "ws-testbench", turnId: "t-1" });
    mocks.cancelChatTurn.mockResolvedValueOnce({ cancelled: true, trace: { status: "waiting_for_approval" } });
    await expect(run("chat.cancel-waiting-turn")).rejects.toThrow("waiting_for_approval, not cancelled");
  });
});

describe("user input", () => {
  it("answers the seeded prompt and waits for it to clear", async () => {
    mocks.seedChatUserInputScenario.mockResolvedValueOnce({ sessionId: "s-1", workspaceId: "ws-testbench", turnId: "t-2", promptId: "p-1" });
    mocks.answerChatUserInputPrompt.mockResolvedValueOnce({ ok: true, resumed: true });
    mocks.fetchChatThread.mockResolvedValueOnce({ turns: [{ turnId: "t-2", trace: {} }] });
    await expect(run("chat.user-input")).resolves.toMatchObject({ status: "pass", summary: "Answered; the turn resumed: yes." });
    expect(mocks.answerChatUserInputPrompt).toHaveBeenCalledWith("s-1", "t-2", "p-1", {
      response: { kind: "single_select", optionId: "option-a" },
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/chat-turns.test.ts'`
Expected: FAIL, because `./chat-turns` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/catalog/chat-turns.ts`:

```ts
import {
  answerChatUserInputPrompt,
  cancelChatTurn,
  fetchChatThread,
  preflightChatRoute,
  streamAgentChatMessage,
} from "@goatcitadel/mission-control-shared/api/chat";
import { ensure, pass, summarizeEvidence, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { createScratchSession, requireWorkspace } from "./context";
import { seedChatApprovalScenario, seedChatUserInputScenario } from "./dev-verification";

type StreamChunk = Parameters<Parameters<typeof streamAgentChatMessage>[2]>[0];

const PROMPT = "Reply with a short greeting for the GoatCitadel test bench.";

export const chatTurnChecks: readonly CheckDef[] = [
  {
    id: "chat.stream-reply",
    kind: "journey",
    domain: "chat",
    title: "Route preflight and streamed reply",
    tier: "mutate",
    needsWorkspace: true,
    description: "In the sandbox the reply comes from the deterministic stub.",
    routes: [
      "POST /api/v1/chat/sessions",
      "POST /api/v1/chat/sessions/:sessionId/route-preflight",
      "POST /api/v1/chat/sessions/:sessionId/agent-send/stream",
    ],
    steps: ["Create session", "Route preflight", "Stream reply"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "stream"));
      const preflight = await ctx.step("Route preflight", () =>
        preflightChatRoute(session.sessionId, { action: "send", content: PROMPT }),
      );
      ensure(!preflight.blockedReason, `Routing is blocked: ${preflight.blockedReason}.`, preflight);
      const chunks: StreamChunk[] = [];
      await ctx.step("Stream reply", () =>
        streamAgentChatMessage(
          session.sessionId,
          {
            content: PROMPT,
            routeDecision: preflight.decision,
            providerId: preflight.decision.effectiveProviderId,
            model: preflight.decision.effectiveModel,
          },
          (chunk) => {
            chunks.push(chunk);
          },
          { signal: ctx.signal },
        ),
      );
      const text = chunks.flatMap((chunk) => (chunk.type === "delta" ? [chunk.delta] : [])).join("");
      ensure(text.trim() !== "", "The stream carried no reply text.", summarizeEvidence(chunks));
      ensure(chunks.some((chunk) => chunk.type === "done"), "The stream never sent its done event.", summarizeEvidence(chunks));
      return pass(`Streamed ${text.length} characters: “${text.slice(0, 80)}”.`);
    },
  },
  {
    id: "chat.cancel-waiting-turn",
    kind: "journey",
    domain: "chat",
    title: "Cancel a turn that is waiting for approval",
    tier: "mutate",
    needsWorkspace: true,
    routes: [
      "POST /api/v1/chat/sessions",
      "POST /api/v1/dev/verification/chat-approval-scenario",
      "POST /api/v1/chat/sessions/:sessionId/turns/:turnId/cancel",
    ],
    steps: ["Create session", "Seed a turn waiting for approval", "Cancel the turn"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "cancel"));
      const scenario = await ctx.step("Seed a turn waiting for approval", () =>
        seedChatApprovalScenario({ sessionId: session.sessionId, workspaceId: requireWorkspace(ctx) }),
      );
      const result = await ctx.step("Cancel the turn", () => cancelChatTurn(session.sessionId, scenario.turnId, "testbench"));
      ensure(result.cancelled, "The gateway did not cancel the turn.", result);
      ensure(result.trace.status === "cancelled", `The turn is ${result.trace.status}, not cancelled.`, result);
      return pass("The waiting turn was cancelled.", result.trace);
    },
  },
  {
    id: "chat.user-input",
    kind: "journey",
    domain: "chat",
    title: "Answer a user-input prompt",
    tier: "mutate",
    needsWorkspace: true,
    routes: [
      "POST /api/v1/chat/sessions",
      "POST /api/v1/dev/verification/chat-user-input-scenario",
      "POST /api/v1/chat/sessions/:sessionId/turns/:turnId/user-input/:promptId/respond",
      "GET /api/v1/chat/sessions/:sessionId/thread",
    ],
    steps: ["Create session", "Seed a turn asking for input", "Answer the prompt", "Prompt is cleared"],
    async run(ctx) {
      const session = await ctx.step("Create session", () => createScratchSession(ctx, "user input"));
      const scenario = await ctx.step("Seed a turn asking for input", () =>
        seedChatUserInputScenario({ sessionId: session.sessionId, workspaceId: requireWorkspace(ctx) }),
      );
      const answer = await ctx.step("Answer the prompt", () =>
        answerChatUserInputPrompt(session.sessionId, scenario.turnId, scenario.promptId, {
          response: { kind: "single_select", optionId: "option-a" },
        }),
      );
      ensure(answer.ok, "The gateway rejected the answer.", answer);
      await ctx.step("Prompt is cleared", () =>
        waitFor(
          () => fetchChatThread(session.sessionId),
          (thread) => thread.turns.some((turn) => turn.turnId === scenario.turnId && !turn.trace.pendingUserInput),
          { signal: ctx.signal, timeoutMs: 15_000, label: "Clearing the answered prompt" },
        ),
      );
      return pass(`Answered; the turn resumed: ${answer.resumed ? "yes" : "no"}.`, answer);
    },
  },
];
```

Replace `apps/mission-control-next/src/__testbench__/catalog/index.ts` with:

```ts
import type { CheckDef } from "../runner/types";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { chatTurnChecks } from "./chat-turns";
import { healthChecks } from "./health";
import { providerChecks } from "./providers";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
  ...chatTurnChecks,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog'`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/catalog/chat-turns.ts apps/mission-control-next/src/__testbench__/catalog/chat-turns.test.ts apps/mission-control-next/src/__testbench__/catalog/index.ts
git commit -m "feat(testbench): check streamed replies, cancel, and user input"
```

---

### Task 15: Approval journeys

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/catalog/approvals.ts`
- Modify: `apps/mission-control-next/src/__testbench__/catalog/index.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/approvals.test.ts`

**Interfaces:**
- Consumes: `fetchApprovals({ status, limit })` → `{ items: Array<{ approvalId; status }> }` from `.../api/approvals`; `fetchChatPendingApprovals(sessionId)` → `{ items: Array<{ approvalId }> }`, `denyChatTool(sessionId, approvalId)` → `{ ok }`, `approveChatTool(sessionId, approvalId)` → `{ ok; resumed? }` from `.../api/chat`; `fetchDurableRun(runId)` → `{ runId; status }` from `.../api/durable`; `seedChatApprovalScenario` (Task 9); `createScratchSession`, `requireWorkspace` (Task 13); `waitFor` (Task 4).
- Produces: `approvalChecks`.

- [ ] **Step 1: Write the failing test**

Create `apps/mission-control-next/src/__testbench__/catalog/approvals.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { approvalChecks } from "./approvals";

const mocks = vi.hoisted(() => ({
  createChatSession: vi.fn(),
  fetchChatPendingApprovals: vi.fn(),
  denyChatTool: vi.fn(),
  approveChatTool: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchDurableRun: vi.fn(),
  seedChatApprovalScenario: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({
  createChatSession: mocks.createChatSession,
  fetchChatPendingApprovals: mocks.fetchChatPendingApprovals,
  denyChatTool: mocks.denyChatTool,
  approveChatTool: mocks.approveChatTool,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ fetchApprovals: mocks.fetchApprovals }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({ fetchDurableRun: mocks.fetchDurableRun }));
vi.mock("./dev-verification", () => ({ seedChatApprovalScenario: mocks.seedChatApprovalScenario }));

const SCENARIO = {
  sessionId: "s-1",
  workspaceId: "ws-testbench",
  turnId: "t-1",
  approvalId: "4b0c6e0e-6d55-4d2b-9a3c-1f3c9b0a8e11",
  chatTurnDurableRunId: "run-1",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createChatSession.mockResolvedValue({ sessionId: "s-1", revision: 1, lifecycleStatus: "active" });
  mocks.seedChatApprovalScenario.mockResolvedValue(SCENARIO);
  mocks.fetchChatPendingApprovals.mockResolvedValue({ items: [{ approvalId: SCENARIO.approvalId }], activeApprovalId: null, remainingCount: 1 });
});

describe("approval journeys", () => {
  it("rejects the pending approval and finds it recorded as rejected", async () => {
    mocks.denyChatTool.mockResolvedValueOnce({ ok: true, approvalId: SCENARIO.approvalId });
    mocks.fetchApprovals.mockResolvedValueOnce({ items: [{ approvalId: SCENARIO.approvalId, status: "rejected" }] });
    const ctx = makeTestContext();
    await expect(findCheck(approvalChecks, "approvals.reject").run(ctx)).resolves.toMatchObject({ status: "pass" });
    expect(mocks.fetchApprovals).toHaveBeenCalledWith({ status: "rejected", limit: 200 });
    expect(ctx.steps.map((step) => step.title)).toEqual([
      "Create session",
      "Seed approval scenario",
      "Approval is pending",
      "Reject the approval",
      "Approval recorded as rejected",
    ]);
  });

  it("fails when the seeded approval is not pending for the session", async () => {
    mocks.fetchChatPendingApprovals.mockResolvedValueOnce({ items: [], activeApprovalId: null, remainingCount: 0 });
    await expect(findCheck(approvalChecks, "approvals.reject").run(makeTestContext())).rejects.toThrow(
      "The seeded approval is not pending for the session.",
    );
  });

  it("approves, waits for the durable run to wake, and finds the approval recorded", async () => {
    mocks.approveChatTool.mockResolvedValueOnce({ ok: true, approvalId: SCENARIO.approvalId, resumed: true });
    mocks.fetchDurableRun.mockResolvedValueOnce({ runId: "run-1", status: "running" });
    mocks.fetchApprovals.mockResolvedValueOnce({ items: [{ approvalId: SCENARIO.approvalId, status: "approved" }] });
    await expect(findCheck(approvalChecks, "approvals.approve").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Approved; the durable run is now running.",
    });
  });

  it("tiers the approve journey as host because it can run the seeded command", () => {
    expect(findCheck(approvalChecks, "approvals.approve").tier).toBe("host");
    expect(findCheck(approvalChecks, "approvals.reject").tier).toBe("mutate");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/approvals.test.ts'`
Expected: FAIL, because `./approvals` does not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/catalog/approvals.ts`:

```ts
import { fetchApprovals } from "@goatcitadel/mission-control-shared/api/approvals";
import {
  approveChatTool,
  denyChatTool,
  fetchChatPendingApprovals,
} from "@goatcitadel/mission-control-shared/api/chat";
import { fetchDurableRun } from "@goatcitadel/mission-control-shared/api/durable";
import { ensure, pass, waitFor } from "../runner/assert";
import type { CheckContext, CheckDef, RouteKey } from "../runner/types";
import { createScratchSession, requireWorkspace } from "./context";
import { seedChatApprovalScenario, type ChatApprovalScenario } from "./dev-verification";

const SEED_ROUTES: readonly RouteKey[] = [
  "POST /api/v1/chat/sessions",
  "POST /api/v1/dev/verification/chat-approval-scenario",
  "GET /api/v1/chat/tools/approvals",
  "GET /api/v1/approvals",
];

const SEED_STEPS = ["Create session", "Seed approval scenario", "Approval is pending"] as const;

async function seedPendingApproval(ctx: CheckContext): Promise<ChatApprovalScenario> {
  const session = await ctx.step("Create session", () => createScratchSession(ctx, "approval"));
  const scenario = await ctx.step("Seed approval scenario", () =>
    seedChatApprovalScenario({ sessionId: session.sessionId, workspaceId: requireWorkspace(ctx) }),
  );
  await ctx.step("Approval is pending", async () => {
    const pending = await fetchChatPendingApprovals(session.sessionId);
    ensure(
      pending.items.some((item) => item.approvalId === scenario.approvalId),
      "The seeded approval is not pending for the session.",
      pending,
    );
  });
  return scenario;
}

function waitForApprovalStatus(ctx: CheckContext, approvalId: string, status: "approved" | "rejected") {
  return waitFor(
    async () => (await fetchApprovals({ status, limit: 200 })).items.find((item) => item.approvalId === approvalId),
    (found) => found !== undefined,
    { signal: ctx.signal, timeoutMs: 15_000, label: `Recording the approval as ${status}` },
  );
}

export const approvalChecks: readonly CheckDef[] = [
  {
    id: "approvals.reject",
    kind: "journey",
    domain: "approvals",
    title: "Reject a pending tool approval",
    tier: "mutate",
    needsWorkspace: true,
    routes: [...SEED_ROUTES, "POST /api/v1/chat/tools/deny"],
    steps: [...SEED_STEPS, "Reject the approval", "Approval recorded as rejected"],
    async run(ctx) {
      const scenario = await seedPendingApproval(ctx);
      const denied = await ctx.step("Reject the approval", () => denyChatTool(scenario.sessionId, scenario.approvalId));
      ensure(denied.ok, "The gateway did not accept the rejection.", denied);
      const approval = await ctx.step("Approval recorded as rejected", () =>
        waitForApprovalStatus(ctx, scenario.approvalId, "rejected"),
      );
      return pass("The approval was rejected and recorded.", approval);
    },
  },
  {
    id: "approvals.approve",
    kind: "journey",
    domain: "approvals",
    title: "Approve a pending tool approval and resume the turn",
    tier: "host",
    needsWorkspace: true,
    timeoutMs: 120_000,
    description:
      "Approving the seeded shell.exec approval lets the turn resume, which may run its `pnpm test` command on this machine.",
    routes: [...SEED_ROUTES, "POST /api/v1/chat/tools/approve", "GET /api/v1/durable/runs/:runId"],
    steps: [...SEED_STEPS, "Approve the approval", "Durable run leaves waiting", "Approval recorded as approved"],
    async run(ctx) {
      const scenario = await seedPendingApproval(ctx);
      const approved = await ctx.step("Approve the approval", () => approveChatTool(scenario.sessionId, scenario.approvalId));
      ensure(approved.ok, "The gateway did not accept the approval.", approved);
      const run = await ctx.step("Durable run leaves waiting", () =>
        waitFor(
          () => fetchDurableRun(scenario.chatTurnDurableRunId),
          (current) => current.status !== "waiting",
          { signal: ctx.signal, timeoutMs: 30_000, label: "The durable run waking" },
        ),
      );
      const approval = await ctx.step("Approval recorded as approved", () =>
        waitForApprovalStatus(ctx, scenario.approvalId, "approved"),
      );
      return pass(`Approved; the durable run is now ${run.status}.`, { approval, run });
    },
  },
];
```

Replace `apps/mission-control-next/src/__testbench__/catalog/index.ts` with:

```ts
import type { CheckDef } from "../runner/types";
import { approvalChecks } from "./approvals";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { chatTurnChecks } from "./chat-turns";
import { healthChecks } from "./health";
import { providerChecks } from "./providers";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
  ...chatTurnChecks,
  ...approvalChecks,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog'`
Expected: PASS, including the integrity rule that tiers `POST /api/v1/chat/tools/approve` as `host`.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/catalog/approvals.ts apps/mission-control-next/src/__testbench__/catalog/approvals.test.ts apps/mission-control-next/src/__testbench__/catalog/index.ts
git commit -m "feat(testbench): add approval reject and approve journeys"
```

---

### Task 16: Memory, durable, and backup checks

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/catalog/memory.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/durable.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/backups.ts`
- Modify: `apps/mission-control-next/src/__testbench__/catalog/index.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/memory.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/durable.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/backups.test.ts`

**Interfaces:**
- Consumes: `patchMemoryItem(itemId, { content })` → `{ pendingApproval: { approvalId, ... } }`, `forgetMemoryItem(itemId)` → envelope or `{ pendingApproval: null; noMutationRequired: true }`, `isMemoryMutationApprovalEnvelope(value)`, `fetchMemoryItemHistory(itemId)` → `{ items: Array<{ changeType }> }`, `fetchMemoryItems({ workspaceId, namespace, status: "all" })` → `{ items: Array<{ itemId; status }> }` from `.../api/memory`; `resolveApproval(approvalId, "approve")` from `.../api/approvals`; `retryDurableRun(runId, { reason })`, `cancelDurableRun(runId)` → `{ status }` from `.../api/durable`; `createBackup({ name })` → `{ backupId; bytes }`, `listBackups(limit)` → `{ items: Array<{ backupId }> }` from `.../api/system`; `seedMemoryItem`, `seedDurableRecovery` (Task 9); `requireWorkspace` (Task 13).
- Produces: `memoryChecks`, `durableChecks`, `backupChecks`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/catalog/memory.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { memoryChecks } from "./memory";

const mocks = vi.hoisted(() => ({
  patchMemoryItem: vi.fn(),
  forgetMemoryItem: vi.fn(),
  fetchMemoryItemHistory: vi.fn(),
  fetchMemoryItems: vi.fn(),
  resolveApproval: vi.fn(),
  seedMemoryItem: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/memory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/memory")>()),
  patchMemoryItem: mocks.patchMemoryItem,
  forgetMemoryItem: mocks.forgetMemoryItem,
  fetchMemoryItemHistory: mocks.fetchMemoryItemHistory,
  fetchMemoryItems: mocks.fetchMemoryItems,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ resolveApproval: mocks.resolveApproval }));
vi.mock("./dev-verification", () => ({ seedMemoryItem: mocks.seedMemoryItem }));

function envelope(approvalId: string, action: "item_updated" | "items_forgotten") {
  return {
    pendingApproval: {
      approvalId,
      kind: "memory.lifecycle",
      action,
      workspaceId: "ws-testbench",
      requestSha256: "sha",
      itemIds: ["mem-1"],
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.seedMemoryItem.mockResolvedValue({ itemId: "mem-1", workspaceId: "ws-testbench", namespace: "testbench" });
  mocks.patchMemoryItem.mockResolvedValue(envelope("appr-edit", "item_updated"));
  mocks.resolveApproval.mockResolvedValue({ approval: { status: "approved" } });
  mocks.fetchMemoryItemHistory.mockResolvedValue({ items: [{ changeType: "created" }, { changeType: "updated" }] });
});

describe("memory lifecycle", () => {
  it("edits and forgets the item, each through an approval", async () => {
    mocks.forgetMemoryItem.mockResolvedValueOnce(envelope("appr-forget", "items_forgotten"));
    mocks.fetchMemoryItems.mockResolvedValueOnce({ items: [{ itemId: "mem-1", status: "forgotten" }] });
    await expect(findCheck(memoryChecks, "memory.lifecycle").run(makeTestContext())).resolves.toMatchObject({ status: "pass" });
    expect(mocks.resolveApproval.mock.calls).toEqual([
      ["appr-edit", "approve"],
      ["appr-forget", "approve"],
    ]);
    expect(mocks.fetchMemoryItems).toHaveBeenCalledWith({ workspaceId: "ws-testbench", namespace: "testbench", status: "all" });
  });

  it("fails when forgetting does not request an approval", async () => {
    mocks.forgetMemoryItem.mockResolvedValueOnce({
      pendingApproval: null,
      noMutationRequired: true,
      matchedCount: 0,
      alreadyForgottenCount: 0,
    });
    await expect(findCheck(memoryChecks, "memory.lifecycle").run(makeTestContext())).rejects.toThrow(
      "did not request an approval",
    );
  });
});
```

Create `apps/mission-control-next/src/__testbench__/catalog/durable.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { durableChecks } from "./durable";

const mocks = vi.hoisted(() => ({ retryDurableRun: vi.fn(), cancelDurableRun: vi.fn(), seedDurableRecovery: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/durable", () => ({
  retryDurableRun: mocks.retryDurableRun,
  cancelDurableRun: mocks.cancelDurableRun,
}));
vi.mock("./dev-verification", () => ({ seedDurableRecovery: mocks.seedDurableRecovery }));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.seedDurableRecovery.mockResolvedValue({
    orphanRecovery: { approvalId: "a-1", runId: "run-orphan", status: "running", leaseExpiresAt: "t" },
    deadLetterRecovery: { approvalId: "a-2", runId: "run-dead", status: "dead_lettered", deadLetterId: "d-1" },
  });
  mocks.retryDurableRun.mockResolvedValue({ runId: "run-dead", status: "queued" });
});

describe("durable recovery", () => {
  it("retries the dead-lettered run and cancels the orphaned run", async () => {
    mocks.cancelDurableRun.mockResolvedValueOnce({ runId: "run-orphan", status: "cancelled" });
    await expect(findCheck(durableChecks, "durable.recovery").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "The retried run is queued; the orphaned run is cancelled.",
    });
    expect(mocks.retryDurableRun).toHaveBeenCalledWith("run-dead", { reason: "Test bench retry" });
    expect(mocks.cancelDurableRun).toHaveBeenCalledWith("run-orphan");
  });

  it("fails when the orphaned run is not cancelled", async () => {
    mocks.cancelDurableRun.mockResolvedValueOnce({ runId: "run-orphan", status: "running" });
    await expect(findCheck(durableChecks, "durable.recovery").run(makeTestContext())).rejects.toThrow(
      "The orphaned run is running, not cancelled.",
    );
  });
});
```

Create `apps/mission-control-next/src/__testbench__/catalog/backups.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REAL_TARGET, findCheck, makeTestContext } from "../test-support/context";
import { backupChecks } from "./backups";

const mocks = vi.hoisted(() => ({ createBackup: vi.fn(), listBackups: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/system", () => mocks);

beforeEach(() => {
  mocks.createBackup.mockReset();
  mocks.listBackups.mockReset();
  mocks.createBackup.mockResolvedValue({ backupId: "b-1", bytes: 2048, outputPath: "backups/b-1.backup" });
});

describe("backups", () => {
  it("creates a backup and finds it in the list", async () => {
    mocks.listBackups.mockResolvedValueOnce({ items: [{ backupId: "b-1" }] });
    await expect(findCheck(backupChecks, "admin.backup").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Backup b-1 (2048 bytes) is listed.",
    });
    expect(mocks.createBackup).toHaveBeenCalledWith({ name: "testbench" });
  });

  it("fails when the new backup is not listed", async () => {
    mocks.listBackups.mockResolvedValueOnce({ items: [] });
    await expect(findCheck(backupChecks, "admin.backup").run(makeTestContext())).rejects.toThrow("is not listed");
  });

  it("refuses to run outside the verified sandbox", async () => {
    await expect(findCheck(backupChecks, "admin.backup").run(makeTestContext({ target: REAL_TARGET }))).rejects.toThrow(
      "verified sandbox",
    );
    expect(mocks.createBackup).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/memory.test.ts' 'src/__testbench__/catalog/durable.test.ts' 'src/__testbench__/catalog/backups.test.ts'`
Expected: FAIL, because the three modules do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/catalog/memory.ts`:

```ts
import { resolveApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import {
  fetchMemoryItemHistory,
  fetchMemoryItems,
  forgetMemoryItem,
  isMemoryMutationApprovalEnvelope,
  patchMemoryItem,
} from "@goatcitadel/mission-control-shared/api/memory";
import { ensure, pass, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { requireWorkspace } from "./context";
import { seedMemoryItem } from "./dev-verification";

const NAMESPACE = "testbench";

export const memoryChecks: readonly CheckDef[] = [
  {
    id: "memory.lifecycle",
    kind: "journey",
    domain: "memory",
    title: "Memory item lifecycle through approvals",
    tier: "mutate",
    needsWorkspace: true,
    timeoutMs: 90_000,
    routes: [
      "POST /api/v1/dev/verification/memory-item-seed",
      "PATCH /api/v1/memory/items/:itemId",
      "POST /api/v1/approvals/:approvalId/resolve",
      "GET /api/v1/memory/items/:itemId/history",
      "POST /api/v1/memory/items/:itemId/forget",
      "GET /api/v1/memory/items",
    ],
    steps: [
      "Seed memory item",
      "Edit item (approval-first)",
      "Approve the edit",
      "History shows the update",
      "Forget item (approval-first)",
      "Approve the forget",
      "Item is forgotten",
    ],
    async run(ctx) {
      const workspaceId = requireWorkspace(ctx);
      const item = await ctx.step("Seed memory item", () =>
        seedMemoryItem({ workspaceId, namespace: NAMESPACE, title: "Test bench note", content: "Created by the test bench." }),
      );
      const edit = await ctx.step("Edit item (approval-first)", () =>
        patchMemoryItem(item.itemId, { content: "Edited by the test bench." }),
      );
      await ctx.step("Approve the edit", () => resolveApproval(edit.pendingApproval.approvalId, "approve"));
      await ctx.step("History shows the update", () =>
        waitFor(
          () => fetchMemoryItemHistory(item.itemId),
          (history) => history.items.some((event) => event.changeType === "updated"),
          { signal: ctx.signal, timeoutMs: 15_000, label: "The edit reaching the item history" },
        ),
      );
      const forget = await ctx.step("Forget item (approval-first)", () => forgetMemoryItem(item.itemId));
      ensure(isMemoryMutationApprovalEnvelope(forget), "Forgetting the item did not request an approval.", forget);
      await ctx.step("Approve the forget", () => resolveApproval(forget.pendingApproval.approvalId, "approve"));
      await ctx.step("Item is forgotten", () =>
        waitFor(
          () => fetchMemoryItems({ workspaceId, namespace: NAMESPACE, status: "all" }),
          (page) => page.items.some((entry) => entry.itemId === item.itemId && entry.status === "forgotten"),
          { signal: ctx.signal, timeoutMs: 15_000, label: "Forgetting the item" },
        ),
      );
      return pass("The item was edited and then forgotten, each through an approval.");
    },
  },
];
```

Create `apps/mission-control-next/src/__testbench__/catalog/durable.ts`:

```ts
import { cancelDurableRun, retryDurableRun } from "@goatcitadel/mission-control-shared/api/durable";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { seedDurableRecovery } from "./dev-verification";

export const durableChecks: readonly CheckDef[] = [
  {
    id: "durable.recovery",
    kind: "journey",
    domain: "durable",
    title: "Durable run recovery controls",
    tier: "mutate",
    routes: [
      "POST /api/v1/dev/verification/durable-recovery-seed",
      "POST /api/v1/durable/runs/:runId/retry",
      "POST /api/v1/durable/runs/:runId/cancel",
    ],
    steps: ["Seed recovery runs", "Retry the dead-lettered run", "Cancel the orphaned run"],
    async run(ctx) {
      const seed = await ctx.step("Seed recovery runs", () => seedDurableRecovery());
      const retried = await ctx.step("Retry the dead-lettered run", () =>
        retryDurableRun(seed.deadLetterRecovery.runId, { reason: "Test bench retry" }),
      );
      ensure(retried.status !== "dead_lettered", "The retried run is still dead-lettered.", retried);
      const cancelled = await ctx.step("Cancel the orphaned run", () => cancelDurableRun(seed.orphanRecovery.runId));
      ensure(cancelled.status === "cancelled", `The orphaned run is ${cancelled.status}, not cancelled.`, cancelled);
      return pass(`The retried run is ${retried.status}; the orphaned run is cancelled.`);
    },
  },
];
```

Create `apps/mission-control-next/src/__testbench__/catalog/backups.ts`:

```ts
import { createBackup, listBackups } from "@goatcitadel/mission-control-shared/api/system";
import { ensure, pass } from "../runner/assert";
import type { CheckDef } from "../runner/types";

export const backupChecks: readonly CheckDef[] = [
  {
    id: "admin.backup",
    kind: "journey",
    domain: "admin",
    title: "Create and list a backup",
    tier: "mutate",
    description: "Writes a backup file into the sandbox backup folder.",
    routes: ["POST /api/v1/admin/backups/create", "GET /api/v1/admin/backups"],
    steps: ["Create backup", "Backup is listed"],
    async run(ctx) {
      // Belt and braces: the launcher points GOATCITADEL_BACKUP_DIR into the sandbox root.
      ensure(ctx.target.kind === "sandbox", "Backups only run against the verified sandbox.");
      const created = await ctx.step("Create backup", () => createBackup({ name: "testbench" }));
      ensure(created.bytes > 0, "The backup is empty.", created);
      const listed = await ctx.step("Backup is listed", () => listBackups(50));
      ensure(listed.items.some((backup) => backup.backupId === created.backupId), "The new backup is not listed.", listed);
      return pass(`Backup ${created.backupId} (${created.bytes} bytes) is listed.`);
    },
  },
];
```

Replace `apps/mission-control-next/src/__testbench__/catalog/index.ts` with:

```ts
import type { CheckDef } from "../runner/types";
import { approvalChecks } from "./approvals";
import { backupChecks } from "./backups";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { chatTurnChecks } from "./chat-turns";
import { durableChecks } from "./durable";
import { healthChecks } from "./health";
import { memoryChecks } from "./memory";
import { providerChecks } from "./providers";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
  ...chatTurnChecks,
  ...approvalChecks,
  ...memoryChecks,
  ...durableChecks,
  ...backupChecks,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog'`
Expected: PASS.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/catalog/memory.ts apps/mission-control-next/src/__testbench__/catalog/memory.test.ts apps/mission-control-next/src/__testbench__/catalog/durable.ts apps/mission-control-next/src/__testbench__/catalog/durable.test.ts apps/mission-control-next/src/__testbench__/catalog/backups.ts apps/mission-control-next/src/__testbench__/catalog/backups.test.ts apps/mission-control-next/src/__testbench__/catalog/index.ts
git commit -m "feat(testbench): check memory, durable recovery, and backups"
```

---

### Task 17: Realtime and Code Mode checks

**Files:**
- Create: `apps/mission-control-next/src/__testbench__/catalog/realtime.ts`
- Create: `apps/mission-control-next/src/__testbench__/catalog/code-mode.ts`
- Modify: `apps/mission-control-next/src/__testbench__/catalog/index.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/realtime.test.ts`
- Test: `apps/mission-control-next/src/__testbench__/catalog/code-mode.test.ts`

**Interfaces:**
- Consumes: `connectEventStream(onEvent: (event: RealtimeEvent, delivery) => void, onStateChange?, onStatusChange?): () => void` from `@goatcitadel/mission-control-shared/api/client` (`RealtimeEvent` has `eventType`, `sequence`, `payload: Record<string, unknown>`); `createCodeModeRun({ language: "javascript", source })` → `{ runId; status; approvalId? }`, `fetchCodeModeRun(runId)` → `{ status: "approval_pending" | "queued" | "running" | "completed" | "failed" | "rejected" | "expired"; codeHash: string; codeArtifact: { sha256: string }; error? }` from `.../api/capabilities`; `resolveApproval` from `.../api/approvals`; `createScratchSession` (Task 13); `waitFor` (Task 4).
- Produces: `REALTIME_EVENT_TIMEOUT_MS`, `realtimeChecks`, `codeModeChecks`.

- [ ] **Step 1: Write the failing tests**

Create `apps/mission-control-next/src/__testbench__/catalog/realtime.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { REALTIME_EVENT_TIMEOUT_MS, realtimeChecks } from "./realtime";

const mocks = vi.hoisted(() => ({ connectEventStream: vi.fn(), createChatSession: vi.fn(), disconnect: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => ({ connectEventStream: mocks.connectEventStream }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ createChatSession: mocks.createChatSession }));

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session creation event", () => {
  it("passes when the event arrives and always disconnects", async () => {
    let listener: ((event: unknown) => void) | undefined;
    mocks.connectEventStream.mockImplementation((onEvent: (event: unknown) => void) => {
      listener = onEvent;
      return mocks.disconnect;
    });
    mocks.createChatSession.mockImplementation(async () => {
      setTimeout(
        () =>
          listener?.({
            eventId: "e-1",
            sequence: 7,
            eventType: "chat_session_updated",
            source: "chat",
            timestamp: "t",
            payload: { type: "chat_session_created", sessionId: "s-1" },
          }),
        0,
      );
      return { sessionId: "s-1" };
    });
    await expect(findCheck(realtimeChecks, "events.session-created").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Received chat_session_updated for s-1 (sequence 7).",
    });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });

  it("fails after the timeout when no matching event arrives", async () => {
    vi.useFakeTimers();
    mocks.connectEventStream.mockReturnValue(mocks.disconnect);
    mocks.createChatSession.mockResolvedValue({ sessionId: "s-2" });
    const running = findCheck(realtimeChecks, "events.session-created").run(makeTestContext());
    const assertion = expect(running).rejects.toThrow("did not happen within 15 s");
    await vi.advanceTimersByTimeAsync(REALTIME_EVENT_TIMEOUT_MS + 1_000);
    await assertion;
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});
```

Create `apps/mission-control-next/src/__testbench__/catalog/code-mode.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findCheck, makeTestContext } from "../test-support/context";
import { codeModeChecks } from "./code-mode";

const mocks = vi.hoisted(() => ({ createCodeModeRun: vi.fn(), fetchCodeModeRun: vi.fn(), resolveApproval: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/capabilities", () => ({
  createCodeModeRun: mocks.createCodeModeRun,
  fetchCodeModeRun: mocks.fetchCodeModeRun,
}));
vi.mock("@goatcitadel/mission-control-shared/api/approvals", () => ({ resolveApproval: mocks.resolveApproval }));

const SHA = "a".repeat(64);

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createCodeModeRun.mockResolvedValue({ runId: "cm-1", status: "approval_pending", approvalId: "appr-cm" });
  mocks.resolveApproval.mockResolvedValue({ approval: { status: "approved" } });
});

describe("Code Mode run", () => {
  it("approves the run, waits for it to finish, and checks the artifact hash", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({ runId: "cm-1", status: "completed", codeHash: "h", codeArtifact: { sha256: SHA } });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).resolves.toMatchObject({
      status: "pass",
      summary: "Run cm-1 completed; code artifact aaaaaaaaaaaa….",
    });
    expect(mocks.createCodeModeRun).toHaveBeenCalledWith({ language: "javascript", source: "return { ok: true };" });
    expect(mocks.resolveApproval).toHaveBeenCalledWith("appr-cm", "approve");
  });

  it("fails when the run does not wait for approval", async () => {
    mocks.createCodeModeRun.mockResolvedValueOnce({ runId: "cm-1", status: "queued" });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow(
      "did not wait for approval",
    );
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });

  it("fails when the run ends failed", async () => {
    mocks.fetchCodeModeRun.mockResolvedValueOnce({ runId: "cm-1", status: "failed", error: "guest error", codeHash: "h", codeArtifact: { sha256: SHA } });
    await expect(findCheck(codeModeChecks, "code-mode.run").run(makeTestContext())).rejects.toThrow("The run ended failed: guest error.");
  });

  it("is a host check", () => {
    expect(findCheck(codeModeChecks, "code-mode.run").tier).toBe("host");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__/catalog/realtime.test.ts' 'src/__testbench__/catalog/code-mode.test.ts'`
Expected: FAIL, because `./realtime` and `./code-mode` do not exist.

- [ ] **Step 3: Write the implementation**

Create `apps/mission-control-next/src/__testbench__/catalog/realtime.ts`:

```ts
import { connectEventStream } from "@goatcitadel/mission-control-shared/api/client";
import { pass, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";
import { createScratchSession } from "./context";

type RealtimeEvent = Parameters<Parameters<typeof connectEventStream>[0]>[0];

export const REALTIME_EVENT_TIMEOUT_MS = 15_000;

export const realtimeChecks: readonly CheckDef[] = [
  {
    id: "events.session-created",
    kind: "journey",
    domain: "events",
    title: "Session creation reaches the event stream",
    tier: "mutate",
    needsWorkspace: true,
    routes: ["GET /api/v1/events/stream", "POST /api/v1/chat/sessions"],
    steps: ["Open the event stream", "Create session", "Event arrives"],
    async run(ctx) {
      const received: RealtimeEvent[] = [];
      const disconnect = await ctx.step("Open the event stream", async () =>
        connectEventStream((event) => {
          received.push(event);
        }),
      );
      try {
        const session = await ctx.step("Create session", () => createScratchSession(ctx, "realtime"));
        const event = await ctx.step("Event arrives", () =>
          waitFor(
            async () => received.find((candidate) => isSessionCreated(candidate, session.sessionId)),
            (found) => found !== undefined,
            {
              signal: ctx.signal,
              timeoutMs: REALTIME_EVENT_TIMEOUT_MS,
              intervalMs: 200,
              label: "The chat_session_updated event",
            },
          ),
        );
        return pass(`Received ${event?.eventType} for ${session.sessionId} (sequence ${event?.sequence}).`);
      } finally {
        disconnect();
      }
    },
  },
];

function isSessionCreated(event: RealtimeEvent, sessionId: string): boolean {
  return (
    event.eventType === "chat_session_updated" &&
    event.payload.type === "chat_session_created" &&
    event.payload.sessionId === sessionId
  );
}
```

Create `apps/mission-control-next/src/__testbench__/catalog/code-mode.ts`:

```ts
import { resolveApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { createCodeModeRun, fetchCodeModeRun } from "@goatcitadel/mission-control-shared/api/capabilities";
import { ensure, pass, waitFor } from "../runner/assert";
import type { CheckDef } from "../runner/types";

const TRUSTED_SOURCE = "return { ok: true };";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "rejected", "expired"]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const codeModeChecks: readonly CheckDef[] = [
  {
    id: "code-mode.run",
    kind: "journey",
    domain: "code-mode",
    title: "Governed Code Mode run",
    tier: "host",
    timeoutMs: 120_000,
    description:
      "Runs the fixed snippet `return { ok: true };` on this machine after approving it. Code Mode runs trusted code; it is not a hostile-code sandbox.",
    routes: [
      "POST /api/v1/code-mode/runs",
      "POST /api/v1/approvals/:approvalId/resolve",
      "GET /api/v1/code-mode/runs/:runId",
    ],
    steps: ["Create run", "Approve the run", "Run finishes", "Artifact hashes recorded"],
    async run(ctx) {
      const created = await ctx.step("Create run", () =>
        createCodeModeRun({ language: "javascript", source: TRUSTED_SOURCE }),
      );
      const approvalId = created.approvalId;
      ensure(created.status === "approval_pending" && approvalId, "The run did not wait for approval.", created);
      await ctx.step("Approve the run", () => resolveApproval(approvalId, "approve"));
      const finished = await ctx.step("Run finishes", () =>
        waitFor(
          () => fetchCodeModeRun(created.runId),
          (run) => TERMINAL_STATUSES.has(run.status),
          { signal: ctx.signal, timeoutMs: 90_000, intervalMs: 1_000, label: "The Code Mode run finishing" },
        ),
      );
      ensure(
        finished.status === "completed",
        `The run ended ${finished.status}${finished.error ? `: ${finished.error}` : ""}.`,
        finished,
      );
      await ctx.step("Artifact hashes recorded", async () => {
        ensure(finished.codeHash !== "", "The run recorded no code hash.", finished);
        ensure(SHA256_PATTERN.test(finished.codeArtifact.sha256), "The code artifact has no SHA-256.", finished.codeArtifact);
      });
      return pass(`Run ${created.runId} completed; code artifact ${finished.codeArtifact.sha256.slice(0, 12)}….`);
    },
  },
];
```

Replace `apps/mission-control-next/src/__testbench__/catalog/index.ts` with:

```ts
import type { CheckDef } from "../runner/types";
import { approvalChecks } from "./approvals";
import { backupChecks } from "./backups";
import { capabilityChecks } from "./capabilities";
import { chatSessionChecks } from "./chat-sessions";
import { chatTurnChecks } from "./chat-turns";
import { codeModeChecks } from "./code-mode";
import { durableChecks } from "./durable";
import { healthChecks } from "./health";
import { memoryChecks } from "./memory";
import { providerChecks } from "./providers";
import { realtimeChecks } from "./realtime";

export const HAND_WRITTEN_CHECKS: readonly CheckDef[] = [
  ...healthChecks,
  ...providerChecks,
  ...capabilityChecks,
  ...chatSessionChecks,
  ...chatTurnChecks,
  ...approvalChecks,
  ...memoryChecks,
  ...durableChecks,
  ...realtimeChecks,
  ...backupChecks,
  ...codeModeChecks,
];
```

- [ ] **Step 4: Run every test bench test and the typecheck**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__'`
Expected: PASS for every file.

Run: `pnpm --filter @goatcitadel/mission-control-next typecheck`
Expected: exit code 0.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add apps/mission-control-next/src/__testbench__/catalog/realtime.ts apps/mission-control-next/src/__testbench__/catalog/realtime.test.ts apps/mission-control-next/src/__testbench__/catalog/code-mode.ts apps/mission-control-next/src/__testbench__/catalog/code-mode.test.ts apps/mission-control-next/src/__testbench__/catalog/index.ts
git commit -m "feat(testbench): check realtime delivery and governed Code Mode runs"
```

---

### Task 18: Launcher runtime and environment builders

**Files:**
- Create: `scripts/testbench-runtime.mjs`
- Test: `scripts/testbench-runtime.test.mjs`

**Interfaces:**
- Consumes: `prepareUsabilityRuntime(runId, baseUrl, { sourceRoot?, tempParent? })` from `scripts/verification/lib/scenarios/usability-runtime-fixture.mjs` (reads only the tracked `config/goatcitadel.example.json`, writes the stub provider config, copies `skills/`); `DETERMINISTIC_LLM_KEY_ENV` from `scripts/verification/lib/scenarios/deterministic-llm-stub.mjs`.
- Produces (gateway env includes `GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true"`): `TESTBENCH_STUB_KEY`, `DEFAULT_REAL_GATEWAY_ORIGIN`, `prepareTestbenchRuntime({ runId, stubBaseUrl, sourceRoot?, tempParent? })`, `buildTestbenchGatewayEnv(runtimeRoot)`, `buildTestbenchUiEnv({ gatewayUrl, runtimeRoot, realOrigin? })`, `buildTestbenchUrl(uiUrl)`.

- [ ] **Step 1: Write the failing test**

Create `scripts/testbench-runtime.test.mjs`:

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DETERMINISTIC_LLM_KEY_ENV } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import {
  TESTBENCH_STUB_KEY,
  buildTestbenchGatewayEnv,
  buildTestbenchUiEnv,
  buildTestbenchUrl,
  prepareTestbenchRuntime,
} from "./testbench-runtime.mjs";

const SENTINEL = "TESTBENCH-SENTINEL-DO-NOT-COPY";

function makeSourceRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "config"));
  fs.writeFileSync(
    path.join(root, "config", "goatcitadel.example.json"),
    JSON.stringify({ assistant: {}, toolPolicy: {}, budgets: {} }),
  );
  fs.writeFileSync(path.join(root, "config", "goatcitadel.json"), JSON.stringify({ secret: SENTINEL }));
  fs.mkdirSync(path.join(root, "workspaces", "private"), { recursive: true });
  fs.writeFileSync(path.join(root, "workspaces", "private", "AGENTS.md"), SENTINEL);
  fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "# Demo skill\n");
  return root;
}

function listFiles(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

test("prepareTestbenchRuntime copies shipped defaults and skills, never operator config or workspaces", async (t) => {
  const sourceRoot = makeSourceRoot(t);
  const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), "testbench-parent-"));
  t.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));
  const runtimeRoot = await prepareTestbenchRuntime({
    runId: "unit",
    stubBaseUrl: "http://127.0.0.1:1/v1",
    sourceRoot,
    tempParent,
  });
  for (const file of listFiles(runtimeRoot)) {
    assert.equal(fs.readFileSync(file, "utf8").includes(SENTINEL), false, `${file} leaked operator data`);
  }
  assert.equal(fs.existsSync(path.join(runtimeRoot, "workspaces")), false);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "skills", "demo", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "home")), true);
  assert.equal(fs.existsSync(path.join(runtimeRoot, "backups")), true);
});

test("buildTestbenchGatewayEnv keeps home and backups inside the runtime root and turns Code Mode on", () => {
  const runtimeRoot = path.join(os.tmpdir(), "goatcitadel-usability-unit");
  const env = buildTestbenchGatewayEnv(runtimeRoot);
  for (const key of ["GOATCITADEL_HOME", "GOATCITADEL_BACKUP_DIR"]) {
    const relative = path.relative(runtimeRoot, env[key]);
    assert.ok(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), `${key} escapes the runtime root`);
  }
  assert.equal(env.GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED, "true");
  assert.equal(env.GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED, "true");
  assert.equal(env.GOATCITADEL_BUNDLED_POSTGRES_ENABLED, "false");
  assert.equal(env.GOATCITADEL_LLAMACPP_ENABLED, "false");
  assert.equal(env.GOATCITADEL_NPU_ENABLED, "false");
  assert.equal(env[DETERMINISTIC_LLM_KEY_ENV], TESTBENCH_STUB_KEY);
});

test("buildTestbenchUiEnv hands the page the sandbox origin, root, and real origin", () => {
  assert.deepEqual(buildTestbenchUiEnv({ gatewayUrl: "http://127.0.0.1:41873", runtimeRoot: "/tmp/root" }), {
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: "http://127.0.0.1:41873",
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: "/tmp/root",
    VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN: "http://127.0.0.1:8787",
  });
});

test("buildTestbenchUrl points at the sandbox target", () => {
  assert.equal(buildTestbenchUrl("http://127.0.0.1:5199/"), "http://127.0.0.1:5199/testbench.html?target=sandbox");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/testbench-runtime.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./testbench-runtime.mjs`.

- [ ] **Step 3: Write the implementation**

Create `scripts/testbench-runtime.mjs`:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { DETERMINISTIC_LLM_KEY_ENV } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import { prepareUsabilityRuntime } from "./verification/lib/scenarios/usability-runtime-fixture.mjs";

export const TESTBENCH_STUB_KEY = "verification-stub-key";
export const DEFAULT_REAL_GATEWAY_ORIGIN = "http://127.0.0.1:8787";

/**
 * Builds the sandbox runtime root from shipped defaults only: the tracked example config,
 * the deterministic stub as the only provider, and the tracked skills. Operator config,
 * secrets, and workspace guidance are never read.
 */
export async function prepareTestbenchRuntime({ runId, stubBaseUrl, sourceRoot, tempParent }) {
  const runtimeRoot = await prepareUsabilityRuntime(runId, stubBaseUrl, { sourceRoot, tempParent });
  await fs.mkdir(path.join(runtimeRoot, "home"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "backups"), { recursive: true });
  return runtimeRoot;
}

/** Gateway environment on top of the verification stack defaults (SQLite, auth none, no secret store). */
export function buildTestbenchGatewayEnv(runtimeRoot) {
  return {
    GOATCITADEL_HOME: path.join(runtimeRoot, "home"),
    GOATCITADEL_BACKUP_DIR: path.join(runtimeRoot, "backups"),
    GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
    GOATCITADEL_FEATURE_MEMORY_LIFECYCLE_ADMIN_V1_ENABLED: "true",
    GOATCITADEL_RATE_LIMIT_ENABLED: "false",
    GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
    GOATCITADEL_LLAMACPP_AUTOSTART: "false",
    GOATCITADEL_LLAMACPP_ENABLED: "false",
    GOATCITADEL_NPU_AUTOSTART: "false",
    GOATCITADEL_NPU_ENABLED: "false",
    [DETERMINISTIC_LLM_KEY_ENV]: TESTBENCH_STUB_KEY,
  };
}

export function buildTestbenchUiEnv({ gatewayUrl, runtimeRoot, realOrigin = DEFAULT_REAL_GATEWAY_ORIGIN }) {
  return {
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ORIGIN: gatewayUrl,
    VITE_GOATCITADEL_TESTBENCH_SANDBOX_ROOT: runtimeRoot,
    VITE_GOATCITADEL_TESTBENCH_REAL_ORIGIN: realOrigin,
  };
}

export function buildTestbenchUrl(uiUrl) {
  return `${uiUrl.replace(/\/+$/, "")}/testbench.html?target=sandbox`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/testbench-runtime.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add scripts/testbench-runtime.mjs scripts/testbench-runtime.test.mjs
git commit -m "feat(testbench): build the sandbox runtime from shipped defaults only"
```

---

### Task 19: `pnpm testbench` launcher

**Files:**
- Create: `scripts/testbench.mjs`
- Modify: `package.json` (root; one line in `scripts`)

**Interfaces:**
- Consumes: `createRunId(lane)`, `repoRoot` from `scripts/verification/lib/shared.mjs`; `resolveAvailablePort(preferred)`, `startVerificationStack(context, options)` → `{ runtimeRoot, gateway, ui, gatewayUrl, uiUrl }` (`gateway.child` / `ui.child` are `ChildProcess`), `stopVerificationStack(stack)` (never throws) from `scripts/verification/lib/runtime.mjs`; `startDeterministicLlmStub({ expectedAuthorization })` → `{ baseUrl, close() }`; `collectVerificationSecretEnvKeys(configRoot)` from `scripts/verification/lib/scenarios/usability-coverage.mjs`; `ensureOnboardingComplete(gatewayUrl, completedBy)` from `scripts/verification/lib/scenarios.mjs`; Task 18 builders.
- Produces: the `pnpm testbench` command.

- [ ] **Step 1: Write the launcher**

Create `scripts/testbench.mjs`:

```js
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAvailablePort, startVerificationStack, stopVerificationStack } from "./verification/lib/runtime.mjs";
import { ensureOnboardingComplete } from "./verification/lib/scenarios.mjs";
import { startDeterministicLlmStub } from "./verification/lib/scenarios/deterministic-llm-stub.mjs";
import { collectVerificationSecretEnvKeys } from "./verification/lib/scenarios/usability-coverage.mjs";
import { createRunId, repoRoot } from "./verification/lib/shared.mjs";
import {
  TESTBENCH_STUB_KEY,
  buildTestbenchGatewayEnv,
  buildTestbenchUiEnv,
  buildTestbenchUrl,
  prepareTestbenchRuntime,
} from "./testbench-runtime.mjs";

function say(message) {
  process.stdout.write(`[testbench] ${message}\n`);
}

function waitForShutdown(stack, logRoot) {
  return new Promise((resolve) => {
    const finish = (message) => {
      say(message);
      resolve();
    };
    process.once("SIGINT", () => finish("Stopping the test bench…"));
    process.once("SIGTERM", () => finish("Stopping the test bench…"));
    stack.gateway?.child?.once("exit", (code) => finish(`The sandbox gateway exited (code ${code}). Logs: ${logRoot}`));
    stack.ui?.child?.once("exit", (code) => finish(`The test bench UI exited (code ${code}). Logs: ${logRoot}`));
  });
}

async function teardown({ stub, stack, runtimeRoot }) {
  if (stub) {
    await stub.close().catch((error) => {
      process.stderr.write(`[testbench] Closing the LLM stub failed (best-effort cleanup): ${error.message}\n`);
    });
  }
  if (stack || runtimeRoot) {
    // Stops only the processes this launcher started and deletes the sandbox root; never throws.
    await stopVerificationStack(stack ?? { runtimeRoot });
  }
}

async function main() {
  const runId = createRunId("testbench");
  const artifactRoot = path.join(repoRoot, "artifacts", "testbench", runId);
  const logRoot = path.join(artifactRoot, "diagnostics");
  await fs.mkdir(logRoot, { recursive: true });
  // A plain context, not createRunContext: holding the worktree output lock would block every build.
  const context = { runId, artifactRoot };
  const started = {};
  try {
    say("Starting the deterministic LLM stub…");
    started.stub = await startDeterministicLlmStub({ expectedAuthorization: `Bearer ${TESTBENCH_STUB_KEY}` });
    say("Preparing an isolated runtime from shipped defaults…");
    started.runtimeRoot = await prepareTestbenchRuntime({ runId, stubBaseUrl: started.stub.baseUrl });
    const gatewayPort = await resolveAvailablePort(0);
    const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
    const secretEnvKeys = await collectVerificationSecretEnvKeys(path.join(repoRoot, "config"));
    say("Building the gateway workspace and starting the sandbox. The first build can take several minutes…");
    started.stack = await startVerificationStack(context, {
      runtimeRoot: started.runtimeRoot,
      gatewayPort,
      gatewayMode: "built",
      includeUi: true,
      processLogPrefix: "testbench",
      gatewayEnvOmit: secretEnvKeys,
      uiEnvOmit: secretEnvKeys,
      gatewayEnv: buildTestbenchGatewayEnv(started.runtimeRoot),
      uiEnv: buildTestbenchUiEnv({ gatewayUrl, runtimeRoot: started.runtimeRoot }),
    });
    if (started.stack.gatewayUrl !== gatewayUrl) {
      throw new Error(`The gateway started on ${started.stack.gatewayUrl}, not ${gatewayUrl}. Run pnpm testbench again.`);
    }
    say("Completing onboarding on the sandbox…");
    await ensureOnboardingComplete(started.stack.gatewayUrl, "testbench");
    say("Sandbox ready.");
    say(`Test bench: ${buildTestbenchUrl(started.stack.uiUrl)}`);
    say(`Logs (written when each process exits): ${logRoot}`);
    say("Press Ctrl+C to stop the sandbox and delete its runtime folder.");
    await waitForShutdown(started.stack, logRoot);
  } finally {
    await teardown(started);
  }
}

main().catch((error) => {
  process.stderr.write(`[testbench] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the root script**

Another session has uncommitted edits in the root `package.json`. Re-read the file immediately before editing and change only this line, keeping every other change intact.

In `package.json`, replace:

```json
    "smoke": "pnpm --filter @goatcitadel/gateway smoke",
```

with:

```json
    "smoke": "pnpm --filter @goatcitadel/gateway smoke",
    "testbench": "node scripts/testbench.mjs",
```

- [ ] **Step 3: Check that the launcher module loads**

Run: `node --check scripts/testbench.mjs`
Expected: exit code 0 and no output.

Run: `pnpm docs:check`
Expected: exit code 0 (`check-launcher-ui-target` scans only `bin/goatcitadel.mjs` and the bundle builder; `startVerificationStack` already resolves the UI through `resolveUiTarget`).

- [ ] **Step 4: Start the sandbox once**

Start it in the background (PowerShell tool with `run_in_background`):

```powershell
pnpm testbench
```

Expected output, in order: `Starting the deterministic LLM stub…`, `Preparing an isolated runtime…`, `Building the gateway workspace…`, `Completing onboarding on the sandbox…`, `Sandbox ready.`, then a `Test bench: http://127.0.0.1:<port>/testbench.html?target=sandbox` line. If startup fails, the error names the failing phase; read `artifacts/testbench/<runId>/diagnostics/*.log` for the child output. Leave the sandbox running for Task 20.

- [ ] **Step 5: Checkpoint**

Only if commits are authorized:

```powershell
git add scripts/testbench.mjs package.json
git commit -m "feat(testbench): add the pnpm testbench sandbox launcher"
```

Stage `package.json` only if the other session's changes in it have already landed or the operator approves committing them together; otherwise commit `scripts/testbench.mjs` alone and leave the `package.json` line for the operator.

---

### Task 20: Verification lanes and browser proof

**Files:** none created. This task proves the work and reports results.

- [ ] **Step 1: Run the test bench suites**

Run: `& '.\node_modules\.bin\vitest.cmd' run --root 'apps/mission-control-next' 'src/__testbench__'`
Expected: PASS for every file.

Run: `node --test scripts/testbench-runtime.test.mjs`
Expected: PASS.

- [ ] **Step 2: Run the app-wide lanes**

Run each and confirm exit code 0:

```powershell
pnpm --filter @goatcitadel/mission-control-next typecheck
pnpm --filter @goatcitadel/mission-control-next test
pnpm --filter @goatcitadel/mission-control-next build
pnpm --filter @goatcitadel/mission-control-next perf:check
pnpm exec eslint apps/mission-control-next/src/__testbench__ scripts/testbench.mjs scripts/testbench-runtime.mjs scripts/testbench-runtime.test.mjs --max-warnings 0
pnpm docs:check
pnpm verify:repo:hygiene
git diff --check
```

`git diff --check` covers tracked edits only. For the new untracked files, also run:

```powershell
rg -n '\s+$' apps/mission-control-next/testbench.html apps/mission-control-next/src/__testbench__ scripts/testbench.mjs scripts/testbench-runtime.mjs scripts/testbench-runtime.test.mjs docs/superpowers/specs/2026-10-03-mission-control-testbench-live-console-design.md docs/superpowers/plans/2026-10-03-mission-control-testbench-live-console.md
```

Expected: no output (exit code 1 from `rg` means no trailing whitespace).

- [ ] **Step 3: Confirm the production build does not ship the page**

Using the build from Step 2, run: `Test-Path apps/mission-control-next/dist/testbench.html`
Expected: `False`.

- [ ] **Step 4: Browser proof against the sandbox**

With `pnpm testbench` running from Task 19:

1. Open the printed `Test bench:` URL in the built-in browser (`preview_start` with `url`).
2. Confirm the badge reads `SANDBOX ✓ verified` and the coverage meter shows a number out of the full route count.
3. Click **Run all allowed**. Do not tick **Allow host checks** and do not confirm external checks unless the operator asks, because host checks run code on this machine.
4. When the live region announces `Run completed: …`, read the failing and blocked rows. For each failure, open its drawer and record the summary.
5. Take a screenshot of the finished console, then one of the **Uncovered routes** tab.
6. Resize to `mobile`, confirm the rail is a dropdown and there is no horizontal scroll, take a screenshot, then reset to `desktop`.
7. Stop the launcher (stop the background task). Confirm the runtime folder printed in the logs no longer exists.

- [ ] **Step 5: Optional real-gateway pass**

Only if the operator's everyday gateway is running: open `http://127.0.0.1:5173/testbench.html?target=real` from the normal `pnpm dev` server, confirm the badge reads `REAL gateway`, run **Run all allowed** (read-only checks only), and screenshot the result. Do not confirm any external check unless the operator asks.

- [ ] **Step 6: Report**

Report to the operator: what changed (files), which lanes ran and their results, the sandbox run counts (pass, fail, blocked, skipped) with the summary of each failure, the coverage number, which steps were not run (host checks, external checks, real-gateway pass), and any remaining risk.
