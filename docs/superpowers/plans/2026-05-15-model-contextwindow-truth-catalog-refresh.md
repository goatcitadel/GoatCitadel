# Model contextWindow truth + Provider catalog refresh — Implementation Plan

> Implementation-plan artifact only. This document may name proposed files, commands, tests, and runtime behavior; treat those as plan intent, not shipped 1.0 truth, unless the current implementation and release evidence prove them.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `LlmModelRecord` carry catalog-backed `contextWindow` and `outputTokenLimit`, source them from a versioned manifest/probe metadata path, surface the active model's window across `/status` surfaces when known, clamp compaction summary reserves to the active model's output cap, and refresh the example provider catalog (xAI API-key provider, DeepSeek v4-pro, Kimi K2.6 rename, ChatGPT Instant alias).

**Architecture:**
- A new JSON manifest (`config/llm-model-metadata.json`) keyed by `<providerId>/<modelId>` glob entries (with `*` wildcard) returns `{contextWindow, outputTokenLimit, thinking?}`.
- `packages/contracts/src/llm.ts` extends `LlmModelRecord`/`LlmProviderSummary`/`LlmRuntimeConfig` with optional `contextWindow`/`outputTokenLimit` fields (additive, backwards compatible). A new `LlmApiStyle` value `bedrock-messages` is added.
- `apps/gateway/src/services/llm-service.ts` loads the manifest at construction (with `process.env`-override path), exposes `enrichModelMetadata(providerId, model)` and `clampSummaryReserveTokens(modelMetadata, requested)`, and decorates every `LlmModelRecord` it returns through `listModels`/`previewModels` with metadata.
- `apps/gateway/src/services/chat-compaction.ts` gets a pure `clampSummaryReserveTokens(requested, outputTokenLimit)` helper (returns `{value, clamped, warning?}`).
- `/status` surfaces (gateway runtime endpoint, doctor engine probe, admin-cli, TUI status, Mission Control `ChatModelPicker`) read the active model metadata via the runtime config.
- `config/llm-providers.example.json` is updated with an xAI Grok API-key provider, ChatGPT Instant alias override, DeepSeek v4-pro, Kimi rename to k2.6.

**Tech Stack:** TypeScript, Node 22, Fastify, Vitest, Zod, undici, pnpm workspaces.

---

## File Structure

**Modify:**
- `packages/contracts/src/llm.ts` — add `contextWindow?`/`outputTokenLimit?` to `LlmModelRecord`, `LlmProviderSummary`, `LlmRuntimeConfig`; add `bedrock-messages` to `LlmApiStyle`.
- `packages/contracts/src/config-schemas.ts` — extend the `apiStyle` zod enum with `bedrock-messages`.
- `packages/contracts/src/index.ts` — re-export any new public types if not already.
- `apps/gateway/src/routes/llm.ts` — extend zod `llmApiStyleSchema` with `bedrock-messages`.
- `apps/gateway/src/services/llm-service.ts` — load manifest, decorate model records, expose `getActiveModelMetadata()` for `/status` consumers, surface `clampSummaryReserveTokens(...)` on the service.
- `apps/gateway/src/services/chat-compaction.ts` — add `clampSummaryReserveTokens` pure helper.
- `apps/gateway/src/doctor/engine.ts` — add a probe that asserts the active model has a known contextWindow.
- `apps/gateway/src/admin-cli.ts` — surface contextWindow / outputTokenLimit in the LLM status section if present.
- `apps/gateway/src/tui/main-helpers.ts` — display contextWindow on the active-model status line (if a status line exists; otherwise add to llm summary helper).
- `packages/mission-control-shared/src/components/ChatModelPicker.tsx` — show contextWindow on the active-model row when present.
- `config/llm-providers.example.json` — xAI Grok API-key provider, ChatGPT Instant alias override, DeepSeek v4-pro (replace `deepseek-v4-flash`), rename `kimi-k2.5`→`kimi-k2.6`, ensure `openai-codex` knownModels suppress 5.1/5.2/5.3.

**Create:**
- `config/llm-model-metadata.json` — versioned manifest.
- `packages/contracts/src/llm-model-metadata.ts` — type for the manifest entries (`LlmModelMetadataEntry`, `LlmModelMetadataManifest`).
- `apps/gateway/src/services/llm-model-metadata.ts` — manifest loader, glob-pattern lookup (`lookupModelMetadata`), tests collocated.
- `apps/gateway/src/services/llm-model-metadata.test.ts` — manifest lookup tests.
- `apps/gateway/src/services/chat-compaction.clamp.test.ts` — clamp helper tests.
- `apps/gateway/src/services/llm-service.contextwindow.test.ts` — model-record decoration + clamp wiring tests.

---

## Task 0: Sync with worktree branch & confirm baseline

**Files:**
- None modified.

- [ ] **Step 1: Verify worktree is clean**

```bash
git status --short
```

Expected: empty output (clean tree).

- [ ] **Step 2: Run targeted baseline tests so we know they're green BEFORE we touch anything**

```bash
pnpm --filter @goatcitadel/contracts typecheck && pnpm --filter @goatcitadel/gateway typecheck
```

Expected: typecheck passes both packages.

- [ ] **Step 3: Snapshot llm-service + chat-compaction test counts**

```bash
cd apps/gateway && npx vitest run src/services/llm-service.test.ts src/services/chat-message-history-service.test.ts src/services/gateway-service.compaction.test.ts
```

Expected: green. Note pass count for later comparison.

---

## Task 1: Add `contextWindow` and `outputTokenLimit` to LlmModelRecord (contracts)

**Files:**
- Modify: `packages/contracts/src/llm.ts:123-128` (`LlmModelRecord`)
- Modify: `packages/contracts/src/llm.ts:101-115` (`LlmProviderSummary`)
- Modify: `packages/contracts/src/llm.ts:117-121` (`LlmRuntimeConfig`)

- [ ] **Step 1: Write the failing contract test**

Create `packages/contracts/src/llm.context-window.test.ts`:

```typescript
import { describe, it, expectTypeOf } from "vitest";
import type { LlmModelRecord, LlmProviderSummary, LlmRuntimeConfig } from "./llm.js";

describe("LlmModelRecord context window fields", () => {
  it("LlmModelRecord carries optional contextWindow and outputTokenLimit", () => {
    const record: LlmModelRecord = {
      id: "claude-opus-4-7",
      contextWindow: 1_000_000,
      outputTokenLimit: 32_000,
    };
    expectTypeOf(record.contextWindow).toEqualTypeOf<number | undefined>();
    expectTypeOf(record.outputTokenLimit).toEqualTypeOf<number | undefined>();
  });

  it("LlmProviderSummary exposes active-model metadata", () => {
    const summary: LlmProviderSummary = {
      providerId: "openai-codex",
      label: "OpenAI Codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      apiStyle: "openai-codex-responses",
      defaultModel: "gpt-5.5",
      hasApiKey: false,
      apiKeySource: "none",
      activeModelContextWindow: 272_000,
      activeModelOutputTokenLimit: 32_000,
    };
    expectTypeOf(summary.activeModelContextWindow).toEqualTypeOf<number | undefined>();
    expectTypeOf(summary.activeModelOutputTokenLimit).toEqualTypeOf<number | undefined>();
  });

  it("LlmRuntimeConfig exposes active-model metadata at the top level", () => {
    const config: LlmRuntimeConfig = {
      activeProviderId: "openai-codex",
      activeModel: "gpt-5.5",
      providers: [],
      activeModelContextWindow: 272_000,
      activeModelOutputTokenLimit: 32_000,
    };
    expectTypeOf(config.activeModelContextWindow).toEqualTypeOf<number | undefined>();
    expectTypeOf(config.activeModelOutputTokenLimit).toEqualTypeOf<number | undefined>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/contracts && npx vitest run src/llm.context-window.test.ts
```

Expected: typecheck FAIL — `contextWindow`, `outputTokenLimit`, `activeModelContextWindow`, `activeModelOutputTokenLimit` not present.

- [ ] **Step 3: Extend the three interfaces in `packages/contracts/src/llm.ts`**

In `LlmModelRecord` (line 123-128) add two optional fields:

```typescript
export interface LlmModelRecord {
  id: string;
  label?: string;
  ownedBy?: string;
  created?: number;
  contextWindow?: number;
  outputTokenLimit?: number;
}
```

In `LlmProviderSummary` (line 101-115) add `activeModelContextWindow` + `activeModelOutputTokenLimit`:

```typescript
export interface LlmProviderSummary {
  providerId: string;
  label: string;
  baseUrl: string;
  apiStyle: LlmApiStyle;
  resolvedApiStyle?: LlmApiStyle;
  defaultModel: string;
  authMode?: LlmProviderAuthMode;
  oauthStatus?: LlmProviderOAuthStatus;
  hasApiKey: boolean;
  apiKeySource: "inline" | "env" | "keychain" | "none";
  hasKeychainSecret?: boolean;
  apiKeyRef?: string;
  capabilities?: LlmProviderCapabilities;
  activeModelContextWindow?: number;
  activeModelOutputTokenLimit?: number;
}
```

In `LlmRuntimeConfig` (line 117-121) add the same fields:

```typescript
export interface LlmRuntimeConfig {
  activeProviderId: string;
  activeModel: string;
  providers: LlmProviderSummary[];
  activeModelContextWindow?: number;
  activeModelOutputTokenLimit?: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/contracts && npx vitest run src/llm.context-window.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full contracts typecheck**

```bash
pnpm --filter @goatcitadel/contracts typecheck
```

Expected: PASS.

- [ ] **Step 6: Run gateway typecheck (should still pass — fields are additive)**

```bash
pnpm --filter @goatcitadel/gateway typecheck
```

Expected: PASS.

---

## Task 2: Add `bedrock-messages` to LlmApiStyle (contracts + route schema)

**Files:**
- Modify: `packages/contracts/src/llm.ts:1-5` (`LlmApiStyle` union)
- Modify: `packages/contracts/src/config-schemas.ts:194`
- Modify: `apps/gateway/src/routes/llm.ts:4-9`

- [ ] **Step 1: Add failing assertion to contracts**

Append to `packages/contracts/src/llm.context-window.test.ts`:

```typescript
import type { LlmApiStyle } from "./llm.js";
import { describe as describe2, it as it2, expectTypeOf as expectTypeOf2 } from "vitest";

describe2("LlmApiStyle includes bedrock-messages", () => {
  it2("accepts the bedrock-messages variant", () => {
    const style: LlmApiStyle = "bedrock-messages";
    expectTypeOf2(style).toEqualTypeOf<LlmApiStyle>();
  });
});
```

(Or replace the duplicate `describe`/`it`/`expectTypeOf` imports with a single import at the top; the duplicate-aliased form above is shown for clarity in case the file already imports them.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/contracts && npx vitest run src/llm.context-window.test.ts
```

Expected: typecheck FAIL — `"bedrock-messages"` not assignable.

- [ ] **Step 3: Add `bedrock-messages` to the LlmApiStyle union in `packages/contracts/src/llm.ts`**

```typescript
export type LlmApiStyle =
  | "openai-chat-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "bedrock-messages";
```

- [ ] **Step 4: Update the zod enum in `packages/contracts/src/config-schemas.ts:194`**

```typescript
apiStyle: z.enum([
  "openai-chat-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-messages",
]),
```

- [ ] **Step 5: Update `apps/gateway/src/routes/llm.ts:4-9`**

```typescript
const llmApiStyleSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-messages",
]);
```

- [ ] **Step 6: Verify the contract test passes**

```bash
cd packages/contracts && npx vitest run src/llm.context-window.test.ts
```

Expected: PASS.

- [ ] **Step 7: Check that no exhaustive switch on LlmApiStyle is broken**

```bash
pnpm --filter @goatcitadel/gateway typecheck
```

Expected: PASS. If TS complains about non-exhaustive switches anywhere, treat each as a follow-up — either add a default-throws branch (preferred for forward-compat enums) or list the new style. List each affected file in the commit message.

- [ ] **Step 8: Commit Tasks 1 + 2 together**

```bash
git add packages/contracts/src/llm.ts packages/contracts/src/config-schemas.ts packages/contracts/src/llm.context-window.test.ts apps/gateway/src/routes/llm.ts
git commit -m "feat(contracts): add contextWindow/outputTokenLimit + bedrock-messages api style"
```

---

## Task 3: Model metadata manifest type + JSON file

**Files:**
- Create: `packages/contracts/src/llm-model-metadata.ts`
- Modify: `packages/contracts/src/index.ts` (re-export types)
- Create: `config/llm-model-metadata.json`

- [ ] **Step 1: Write the failing test for the metadata type**

Create `packages/contracts/src/llm-model-metadata.test.ts`:

```typescript
import { describe, it, expectTypeOf } from "vitest";
import type { LlmModelMetadataEntry, LlmModelMetadataManifest } from "./llm-model-metadata.js";

describe("LlmModelMetadataManifest", () => {
  it("manifest entry has contextWindow, outputTokenLimit, optional thinking", () => {
    const entry: LlmModelMetadataEntry = {
      contextWindow: 272_000,
      outputTokenLimit: 32_000,
    };
    expectTypeOf(entry.contextWindow).toEqualTypeOf<number>();
    expectTypeOf(entry.outputTokenLimit).toEqualTypeOf<number>();
    expectTypeOf(entry.thinking).toEqualTypeOf<"off" | "auto" | undefined>();
  });

  it("manifest is a versioned record with pattern keys", () => {
    const manifest: LlmModelMetadataManifest = {
      version: 1,
      entries: {
        "openai-codex/*": { contextWindow: 272_000, outputTokenLimit: 32_000 },
        "xai/grok-4.3": { contextWindow: 1_000_000, outputTokenLimit: 32_000, thinking: "off" },
      },
    };
    expectTypeOf(manifest.version).toEqualTypeOf<number>();
    expectTypeOf(manifest.entries).toEqualTypeOf<Record<string, LlmModelMetadataEntry>>();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/contracts && npx vitest run src/llm-model-metadata.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the type module**

Create `packages/contracts/src/llm-model-metadata.ts`:

```typescript
export interface LlmModelMetadataEntry {
  contextWindow: number;
  outputTokenLimit: number;
  thinking?: "off" | "auto";
}

export interface LlmModelMetadataManifest {
  version: number;
  entries: Record<string, LlmModelMetadataEntry>;
}
```

- [ ] **Step 4: Re-export from `packages/contracts/src/index.ts`**

Add a line near other llm-related re-exports (search the file for `from "./llm.js"` and place this nearby):

```typescript
export type { LlmModelMetadataEntry, LlmModelMetadataManifest } from "./llm-model-metadata.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/contracts && npx vitest run src/llm-model-metadata.test.ts
```

Expected: PASS.

- [ ] **Step 6: Create the manifest file**

Create `config/llm-model-metadata.json`:

```json
{
  "version": 1,
  "entries": {
    "openai-codex/*": { "contextWindow": 272000, "outputTokenLimit": 32000 },
    "openai/chat-latest": { "contextWindow": 128000, "outputTokenLimit": 16000 },
    "openai/gpt-5.4": { "contextWindow": 400000, "outputTokenLimit": 32000 },
    "openai/gpt-5.4-mini": { "contextWindow": 400000, "outputTokenLimit": 32000 },
    "openai/gpt-5.5": { "contextWindow": 400000, "outputTokenLimit": 32000 },
    "anthropic/claude-opus-4-7": { "contextWindow": 1000000, "outputTokenLimit": 32000 },
    "anthropic/claude-sonnet-4-6": { "contextWindow": 1000000, "outputTokenLimit": 32000 },
    "anthropic/claude-haiku-4-5": { "contextWindow": 400000, "outputTokenLimit": 16000 },
    "claude-code/claude-sonnet-4-6": { "contextWindow": 1000000, "outputTokenLimit": 32000 },
    "claude-code/claude-opus-4-7": { "contextWindow": 1000000, "outputTokenLimit": 32000 },
    "xai/grok-4.3": { "contextWindow": 1000000, "outputTokenLimit": 32000, "thinking": "off" },
    "xai/*": { "contextWindow": 256000, "outputTokenLimit": 16000 },
    "openrouter/deepseek/deepseek-v4-pro": { "contextWindow": 128000, "outputTokenLimit": 32000 },
    "openrouter/anthropic/claude-opus-4-7": { "contextWindow": 1000000, "outputTokenLimit": 32000 },
    "deepseek/deepseek-v4-pro": { "contextWindow": 128000, "outputTokenLimit": 32000 },
    "deepseek/deepseek-v4-flash": { "contextWindow": 128000, "outputTokenLimit": 16000 },
    "moonshot/kimi-k2.6": { "contextWindow": 256000, "outputTokenLimit": 32000 },
    "moonshot/kimi-k2.5": { "contextWindow": 256000, "outputTokenLimit": 32000 },
    "google/models/gemini-2.5-pro": { "contextWindow": 2000000, "outputTokenLimit": 8192 },
    "google/models/gemini-2.5-flash": { "contextWindow": 1000000, "outputTokenLimit": 8192 },
    "mistral/*": { "contextWindow": 128000, "outputTokenLimit": 16000 },
    "glm/*": { "contextWindow": 128000, "outputTokenLimit": 16000 },
    "perplexity/*": { "contextWindow": 128000, "outputTokenLimit": 8192 },
    "vercel/*": { "contextWindow": 128000, "outputTokenLimit": 16000 },
    "minimax/*": { "contextWindow": 256000, "outputTokenLimit": 16000 }
  }
}
```

- [ ] **Step 7: Verify the manifest parses against the type**

Add a quick assert to `packages/contracts/src/llm-model-metadata.test.ts`:

```typescript
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

describe("shipped manifest", () => {
  it("config/llm-model-metadata.json parses against LlmModelMetadataManifest", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
    const raw = readFileSync(join(repoRoot, "config/llm-model-metadata.json"), "utf8");
    const parsed = JSON.parse(raw) as LlmModelMetadataManifest;
    expect(parsed.version).toBe(1);
    expect(typeof parsed.entries).toBe("object");
    for (const [key, entry] of Object.entries(parsed.entries)) {
      expect(entry.contextWindow, `${key} contextWindow`).toBeGreaterThan(0);
      expect(entry.outputTokenLimit, `${key} outputTokenLimit`).toBeGreaterThan(0);
      if (entry.thinking !== undefined) {
        expect(["off", "auto"]).toContain(entry.thinking);
      }
    }
  });
});
```

Also add `import { expect } from "vitest";` if not present already.

- [ ] **Step 8: Run all contracts tests**

```bash
cd packages/contracts && npx vitest run
```

Expected: PASS. (Note: if the `repoRoot` resolution above fails due to differing source layouts, calibrate the relative path during this step; the test must end up reading the actual `config/llm-model-metadata.json` at the repo root.)

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/llm-model-metadata.ts packages/contracts/src/llm-model-metadata.test.ts packages/contracts/src/index.ts config/llm-model-metadata.json
git commit -m "feat(contracts,config): add LLM model metadata manifest with contextWindow/outputTokenLimit"
```

---

## Task 4: Manifest loader + glob lookup (gateway service)

**Files:**
- Create: `apps/gateway/src/services/llm-model-metadata.ts`
- Create: `apps/gateway/src/services/llm-model-metadata.test.ts`

- [ ] **Step 1: Write the failing loader test**

Create `apps/gateway/src/services/llm-model-metadata.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadLlmModelMetadataManifest,
  lookupModelMetadata,
  type LlmModelMetadataLoaderResult,
} from "./llm-model-metadata.js";

describe("LLM model metadata loader", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "llm-meta-"));
  });

  it("loads a manifest from disk", () => {
    const path = join(tmp, "manifest.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        entries: {
          "openai-codex/*": { contextWindow: 272000, outputTokenLimit: 32000 },
        },
      }),
    );
    const result = loadLlmModelMetadataManifest(path);
    expect(result.manifest.version).toBe(1);
    expect(Object.keys(result.manifest.entries)).toContain("openai-codex/*");
    expect(result.errors).toEqual([]);
  });

  it("returns empty manifest + warning when file missing", () => {
    const result = loadLlmModelMetadataManifest(join(tmp, "missing.json"));
    expect(result.manifest.entries).toEqual({});
    expect(result.errors.length).toBe(1);
  });

  it("looks up exact provider+model match before wildcard", () => {
    const manifest = {
      version: 1,
      entries: {
        "openai-codex/*": { contextWindow: 272000, outputTokenLimit: 32000 },
        "openai-codex/gpt-5.5": { contextWindow: 272000, outputTokenLimit: 64000 },
      },
    };
    const entry = lookupModelMetadata(manifest, "openai-codex", "gpt-5.5");
    expect(entry).toEqual({ contextWindow: 272000, outputTokenLimit: 64000 });
  });

  it("falls back to provider wildcard when exact missing", () => {
    const manifest = {
      version: 1,
      entries: {
        "openai-codex/*": { contextWindow: 272000, outputTokenLimit: 32000 },
      },
    };
    const entry = lookupModelMetadata(manifest, "openai-codex", "gpt-5.5-codex-unknown");
    expect(entry).toEqual({ contextWindow: 272000, outputTokenLimit: 32000 });
  });

  it("returns undefined when no pattern matches", () => {
    const manifest = { version: 1, entries: {} };
    const entry = lookupModelMetadata(manifest, "unknown", "model");
    expect(entry).toBeUndefined();
  });

  it("matches nested model ids like openrouter/deepseek/deepseek-v4-pro", () => {
    const manifest = {
      version: 1,
      entries: {
        "openrouter/deepseek/deepseek-v4-pro": { contextWindow: 128000, outputTokenLimit: 32000 },
      },
    };
    const entry = lookupModelMetadata(manifest, "openrouter", "deepseek/deepseek-v4-pro");
    expect(entry).toEqual({ contextWindow: 128000, outputTokenLimit: 32000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/gateway && npx vitest run src/services/llm-model-metadata.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the loader**

Create `apps/gateway/src/services/llm-model-metadata.ts`:

```typescript
import { readFileSync } from "node:fs";
import type { LlmModelMetadataEntry, LlmModelMetadataManifest } from "@goatcitadel/contracts";

export interface LlmModelMetadataLoaderResult {
  manifest: LlmModelMetadataManifest;
  errors: string[];
}

const EMPTY_MANIFEST: LlmModelMetadataManifest = { version: 1, entries: {} };

export function loadLlmModelMetadataManifest(path: string): LlmModelMetadataLoaderResult {
  const errors: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    errors.push(`llm-model-metadata: could not read ${path}: ${(error as Error).message}`);
    return { manifest: { ...EMPTY_MANIFEST }, errors };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    errors.push(`llm-model-metadata: invalid JSON in ${path}: ${(error as Error).message}`);
    return { manifest: { ...EMPTY_MANIFEST }, errors };
  }
  if (!isManifest(parsed)) {
    errors.push(`llm-model-metadata: ${path} does not match manifest shape`);
    return { manifest: { ...EMPTY_MANIFEST }, errors };
  }
  return { manifest: parsed, errors };
}

export function lookupModelMetadata(
  manifest: LlmModelMetadataManifest,
  providerId: string,
  modelId: string,
): LlmModelMetadataEntry | undefined {
  const exact = manifest.entries[`${providerId}/${modelId}`];
  if (exact) return exact;
  const providerWildcard = manifest.entries[`${providerId}/*`];
  if (providerWildcard) return providerWildcard;
  return undefined;
}

function isManifest(value: unknown): value is LlmModelMetadataManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<LlmModelMetadataManifest>;
  if (typeof candidate.version !== "number") return false;
  if (!candidate.entries || typeof candidate.entries !== "object") return false;
  for (const entry of Object.values(candidate.entries)) {
    if (!entry || typeof entry !== "object") return false;
    const meta = entry as Partial<LlmModelMetadataEntry>;
    if (typeof meta.contextWindow !== "number" || meta.contextWindow <= 0) return false;
    if (typeof meta.outputTokenLimit !== "number" || meta.outputTokenLimit <= 0) return false;
    if (meta.thinking !== undefined && meta.thinking !== "off" && meta.thinking !== "auto") return false;
  }
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/gateway && npx vitest run src/services/llm-model-metadata.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/services/llm-model-metadata.ts apps/gateway/src/services/llm-model-metadata.test.ts
git commit -m "feat(gateway): add LLM model metadata loader with glob-pattern lookup"
```

---

## Task 5: Pure `clampSummaryReserveTokens` helper in chat-compaction

**Files:**
- Modify: `apps/gateway/src/services/chat-compaction.ts` (append exports near existing ones)
- Create: `apps/gateway/src/services/chat-compaction.clamp.test.ts`

- [ ] **Step 1: Write the failing clamp test**

Create `apps/gateway/src/services/chat-compaction.clamp.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { clampSummaryReserveTokens } from "./chat-compaction.js";

describe("clampSummaryReserveTokens", () => {
  it("returns the requested value when within limit", () => {
    expect(clampSummaryReserveTokens(8000, 32000)).toEqual({
      value: 8000,
      clamped: false,
    });
  });

  it("clamps to the output token limit and surfaces a warning", () => {
    const result = clampSummaryReserveTokens(64000, 32000);
    expect(result.value).toBe(32000);
    expect(result.clamped).toBe(true);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("32000");
  });

  it("returns the requested value when outputTokenLimit is undefined", () => {
    expect(clampSummaryReserveTokens(64000, undefined)).toEqual({
      value: 64000,
      clamped: false,
    });
  });

  it("floors negative requests to 0 and clamps", () => {
    const result = clampSummaryReserveTokens(-5, 32000);
    expect(result.value).toBe(0);
    expect(result.clamped).toBe(true);
  });

  it("treats requested equal to limit as not clamped", () => {
    expect(clampSummaryReserveTokens(32000, 32000)).toEqual({
      value: 32000,
      clamped: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd apps/gateway && npx vitest run src/services/chat-compaction.clamp.test.ts
```

Expected: FAIL — `clampSummaryReserveTokens` not exported.

- [ ] **Step 3: Add the helper to `apps/gateway/src/services/chat-compaction.ts`**

Append (near the other exports):

```typescript
export interface ClampSummaryReserveResult {
  value: number;
  clamped: boolean;
  warning?: string;
}

export function clampSummaryReserveTokens(
  requested: number,
  outputTokenLimit: number | undefined,
): ClampSummaryReserveResult {
  const floored = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : 0;
  if (floored !== requested) {
    if (outputTokenLimit === undefined || floored <= outputTokenLimit) {
      return { value: floored, clamped: true };
    }
  }
  if (outputTokenLimit === undefined) {
    return { value: floored, clamped: false };
  }
  if (floored <= outputTokenLimit) {
    return { value: floored, clamped: false };
  }
  return {
    value: outputTokenLimit,
    clamped: true,
    warning: `compaction summary reserve clamped from ${floored} to model output limit ${outputTokenLimit}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd apps/gateway && npx vitest run src/services/chat-compaction.clamp.test.ts
```

Expected: PASS.

- [ ] **Step 5: Re-run existing chat-compaction tests to ensure no regressions**

```bash
cd apps/gateway && npx vitest run src/services/chat-compaction.clamp.test.ts src/services/gateway-service.compaction.test.ts src/services/chat-message-history-service.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/gateway/src/services/chat-compaction.ts apps/gateway/src/services/chat-compaction.clamp.test.ts
git commit -m "feat(gateway): clamp compaction summary reserve to model output limit"
```

---

## Task 6: Wire metadata + clamp into LlmService

**Files:**
- Modify: `apps/gateway/src/services/llm-service.ts` (constructor + `listModels`/`previewModels`/`getRuntimeConfig` + new public methods)
- Create: `apps/gateway/src/services/llm-service.contextwindow.test.ts`

- [ ] **Step 1: Write the failing decoration test**

Create `apps/gateway/src/services/llm-service.contextwindow.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LlmService } from "./llm-service.js";

function tmpManifest(entries: Record<string, { contextWindow: number; outputTokenLimit: number }>): string {
  const dir = mkdtempSync(join(tmpdir(), "llm-svc-meta-"));
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify({ version: 1, entries }));
  return path;
}

describe("LlmService model metadata decoration", () => {
  it("decorates listModels output with contextWindow/outputTokenLimit", async () => {
    const manifestPath = tmpManifest({
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService({
      configFilePath: undefined,
      modelMetadataPath: manifestPath,
      bootstrapConfig: {
        activeProviderId: "anthropic",
        activeModel: "claude-opus-4-7",
        providers: [
          {
            providerId: "anthropic",
            label: "Anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            apiStyle: "anthropic-messages",
            defaultModel: "claude-opus-4-7",
          },
        ],
      },
    });
    const models = await service.listModels("anthropic");
    const opus = models.find((m) => m.id === "claude-opus-4-7");
    expect(opus?.contextWindow).toBe(1_000_000);
    expect(opus?.outputTokenLimit).toBe(32_000);
  });

  it("clampSummaryReserveTokens uses the active model's outputTokenLimit", () => {
    const manifestPath = tmpManifest({
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService({
      configFilePath: undefined,
      modelMetadataPath: manifestPath,
      bootstrapConfig: {
        activeProviderId: "anthropic",
        activeModel: "claude-opus-4-7",
        providers: [
          {
            providerId: "anthropic",
            label: "Anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            apiStyle: "anthropic-messages",
            defaultModel: "claude-opus-4-7",
          },
        ],
      },
    });
    const result = service.clampActiveModelSummaryReserve(200_000);
    expect(result.value).toBe(32_000);
    expect(result.clamped).toBe(true);
  });

  it("getRuntimeConfig includes activeModelContextWindow/OutputTokenLimit", () => {
    const manifestPath = tmpManifest({
      "anthropic/claude-opus-4-7": { contextWindow: 1_000_000, outputTokenLimit: 32_000 },
    });
    const service = new LlmService({
      configFilePath: undefined,
      modelMetadataPath: manifestPath,
      bootstrapConfig: {
        activeProviderId: "anthropic",
        activeModel: "claude-opus-4-7",
        providers: [
          {
            providerId: "anthropic",
            label: "Anthropic",
            baseUrl: "https://api.anthropic.com/v1",
            apiStyle: "anthropic-messages",
            defaultModel: "claude-opus-4-7",
          },
        ],
      },
    });
    const config = service.getRuntimeConfig();
    expect(config.activeModelContextWindow).toBe(1_000_000);
    expect(config.activeModelOutputTokenLimit).toBe(32_000);
  });
});
```

(NOTE: The constructor shape `{ configFilePath, modelMetadataPath, bootstrapConfig }` is illustrative. Step 3 below will reconcile with the actual `LlmService` constructor surface; if it currently takes a different shape, adapt the test to match the actual constructor while preserving the assertion intent.)

- [ ] **Step 2: Inspect actual LlmService constructor surface**

```bash
grep -n "constructor" apps/gateway/src/services/llm-service.ts | head -5
```

Read the lines surrounding the result. Note the actual options shape used by callers. Update the test from Step 1 to instantiate the service using the existing pattern (you may need to write a small `createLlmServiceForTest` helper to inject the manifest path; if so, add it to a fixtures file like `apps/gateway/src/test/llm-fixtures.ts`).

- [ ] **Step 3: Run test to verify it fails**

```bash
cd apps/gateway && npx vitest run src/services/llm-service.contextwindow.test.ts
```

Expected: FAIL — no metadata loaded, no clamp method, runtime config lacks fields.

- [ ] **Step 4: Add manifest plumbing to LlmService**

In `apps/gateway/src/services/llm-service.ts`:

1. Import the loader near the top:

```typescript
import {
  loadLlmModelMetadataManifest,
  lookupModelMetadata,
} from "./llm-model-metadata.js";
import { clampSummaryReserveTokens, type ClampSummaryReserveResult } from "./chat-compaction.js";
import type { LlmModelMetadataManifest } from "@goatcitadel/contracts";
```

2. Add private fields & constructor wiring. Inside `class LlmService` add:

```typescript
private readonly modelMetadata: LlmModelMetadataManifest;
```

In the constructor accept an optional `modelMetadataPath` (default to env override or `config/llm-model-metadata.json` next to the providers file) and assign:

```typescript
const metadataPath =
  options.modelMetadataPath ??
  process.env.GOATCITADEL_LLM_MODEL_METADATA_PATH ??
  defaultModelMetadataPath(options.configFilePath);
const { manifest, errors } = loadLlmModelMetadataManifest(metadataPath);
for (const message of errors) log.warn({ path: metadataPath }, message);
this.modelMetadata = manifest;
```

Add a helper near other file-scope helpers (after `buildFallbackModelCatalog`):

```typescript
function defaultModelMetadataPath(configFilePath: string | undefined): string {
  if (!configFilePath) {
    return "config/llm-model-metadata.json";
  }
  // colocate with provider config: replace filename with llm-model-metadata.json
  const lastSep = Math.max(configFilePath.lastIndexOf("/"), configFilePath.lastIndexOf("\\"));
  const dir = lastSep >= 0 ? configFilePath.slice(0, lastSep) : ".";
  return `${dir}/llm-model-metadata.json`;
}
```

3. Add `enrichModelRecord` private helper:

```typescript
private enrichModelRecord(providerId: string, record: LlmModelRecord): LlmModelRecord {
  const meta = lookupModelMetadata(this.modelMetadata, providerId, record.id);
  if (!meta) return record;
  return {
    ...record,
    contextWindow: record.contextWindow ?? meta.contextWindow,
    outputTokenLimit: record.outputTokenLimit ?? meta.outputTokenLimit,
  };
}
```

4. Decorate `listModels`, `listModelsWithSource`, `previewModels`:

```typescript
public async listModels(providerId?: string): Promise<LlmModelRecord[]> {
  const resolved = await this.resolveProvider(providerId);
  const result = await this.fetchModelsForResolvedProvider(resolved);
  return result.items.map((record) => this.enrichModelRecord(resolved.provider.providerId, record));
}
```

Same pattern for `listModelsWithSource` (decorate `.items` before returning) and `previewModels` (decorate every branch that returns items).

5. Add public `clampActiveModelSummaryReserve`:

```typescript
public clampActiveModelSummaryReserve(requested: number): ClampSummaryReserveResult {
  const meta = lookupModelMetadata(this.modelMetadata, this.activeProviderId, this.activeModel);
  return clampSummaryReserveTokens(requested, meta?.outputTokenLimit);
}
```

6. Decorate `getRuntimeConfig` to include active model metadata:

```typescript
public getRuntimeConfig(): LlmRuntimeConfig {
  const activeMeta = lookupModelMetadata(this.modelMetadata, this.activeProviderId, this.activeModel);
  return {
    activeProviderId: this.activeProviderId,
    activeModel: this.activeModel,
    activeModelContextWindow: activeMeta?.contextWindow,
    activeModelOutputTokenLimit: activeMeta?.outputTokenLimit,
    providers: Array.from(this.providers.values()).map((provider) => {
      const providerMeta = lookupModelMetadata(this.modelMetadata, provider.providerId, provider.defaultModel);
      return {
        ...provider,
        apiKey: undefined,
        headers: undefined,
        activeModelContextWindow: providerMeta?.contextWindow,
        activeModelOutputTokenLimit: providerMeta?.outputTokenLimit,
      };
    }),
  };
}
```

(NOTE: `getRuntimeConfig` may be named differently in current code — match the existing summary-build method. Search for `activeProviderId: this.activeProviderId` to find it.)

- [ ] **Step 5: Run test to verify it passes**

```bash
cd apps/gateway && npx vitest run src/services/llm-service.contextwindow.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Run full llm-service tests to catch regressions**

```bash
cd apps/gateway && npx vitest run src/services/llm-service.test.ts src/services/llm-service.fake-provider.test.ts src/services/llm-service.loop25.test.ts src/services/llm-service.loop31.test.ts src/services/llm-service.loop32.test.ts src/services/llm-service.loop33.test.ts
```

Expected: all pass.

- [ ] **Step 7: Run gateway typecheck**

```bash
pnpm --filter @goatcitadel/gateway typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/gateway/src/services/llm-service.ts apps/gateway/src/services/llm-service.contextwindow.test.ts
git commit -m "feat(gateway): enrich LLM model records with manifest metadata; expose clampActiveModelSummaryReserve"
```

---

## Task 7: Surface contextWindow in `/status` (doctor + admin-cli + tui + ChatModelPicker)

**Files:**
- Modify: `apps/gateway/src/doctor/engine.ts`
- Modify: `apps/gateway/src/admin-cli.ts`
- Modify: `apps/gateway/src/tui/main-helpers.ts`
- Modify: `packages/mission-control-shared/src/components/ChatModelPicker.tsx`
- Modify: existing doctor/admin/tui/picker tests as needed

- [ ] **Step 1: Doctor probe — failing test**

Add to `apps/gateway/src/doctor/engine.test.ts` (find an existing describe block that tests probes and append):

```typescript
it("flags missing active model contextWindow", async () => {
  // Use the existing doctor test harness pattern in this file.
  // Create a service stub where getRuntimeConfig returns activeModelContextWindow === undefined.
  // Assert that the resulting probe list contains a finding with id matching /context-window|model-metadata/i and severity "warning".
});
```

(Calibrate this to the existing harness — read `engine.test.ts` once to see how probes are exercised. The intent is: when active model has no manifest entry, doctor surfaces a warning.)

- [ ] **Step 2: Run the doctor test to confirm it fails**

```bash
cd apps/gateway && npx vitest run src/doctor/engine.test.ts -t "contextWindow"
```

Expected: FAIL.

- [ ] **Step 3: Add the probe to `apps/gateway/src/doctor/engine.ts`**

Locate the probe registration (look for an array of probe functions or a switch on probe names). Add a probe `llm-active-model-metadata`:

```typescript
function probeActiveModelMetadata(deps: DoctorProbeDeps): DoctorFinding[] {
  const runtime = deps.llmService.getRuntimeConfig();
  if (!runtime.activeModel) return [];
  if (runtime.activeModelContextWindow === undefined) {
    return [
      {
        id: "llm-active-model-metadata",
        severity: "warning",
        message: `Active model ${runtime.activeProviderId}/${runtime.activeModel} has no contextWindow in llm-model-metadata.json. /status will omit the catalog-backed limit unless another provider probe supplies one.`,
      },
    ];
  }
  return [];
}
```

Wire it into the probe registry per the file's existing pattern. Type names (`DoctorProbeDeps`, `DoctorFinding`) must match what the file uses — adjust if names differ.

- [ ] **Step 4: Verify doctor test passes**

```bash
cd apps/gateway && npx vitest run src/doctor/engine.test.ts -t "contextWindow"
```

Expected: PASS.

- [ ] **Step 5: Admin-CLI status — failing test**

In `apps/gateway/src/admin-cli.integration.test.ts` (or matching admin-cli test file), add a test that runs the LLM status sub-command and expects the active model's contextWindow / output limit to appear in stdout.

(Read the file once to determine the exact command/format used.) Example:

```typescript
it("admin-cli llm status prints active model contextWindow when available", async () => {
  // Use the existing CLI runner harness in this file with a service stub
  // whose runtime config has activeModelContextWindow: 272_000.
  const stdout = await runAdminCli(["llm", "status"], { /* deps with stub */ });
  expect(stdout).toMatch(/context window:\s*272[,_]?000/i);
  expect(stdout).toMatch(/output limit:\s*32[,_]?000/i);
});
```

- [ ] **Step 6: Update `apps/gateway/src/admin-cli.ts`**

In the LLM status section, append (after the active model line):

```typescript
if (runtime.activeModelContextWindow !== undefined) {
  lines.push(`  Context window: ${runtime.activeModelContextWindow.toLocaleString()}`);
}
if (runtime.activeModelOutputTokenLimit !== undefined) {
  lines.push(`  Output limit:   ${runtime.activeModelOutputTokenLimit.toLocaleString()}`);
}
```

Match the file's existing formatting (indentation, casing). If the file builds output via a different helper (table, json), append fields to that structure instead.

- [ ] **Step 7: Verify admin-cli test passes**

```bash
cd apps/gateway && npx vitest run src/admin-cli.integration.test.ts
```

Expected: PASS.

- [ ] **Step 8: TUI status — failing test**

Open `apps/gateway/src/tui/main-helpers.ts` and locate the helper that renders the LLM status line (likely named `formatLlmStatus`, `renderLlmSummary`, or similar — grep for `activeModel`). Add a test in `apps/gateway/src/tui/main-helpers.loop24.test.ts` (or the appropriate existing tui test file):

```typescript
it("formatLlmStatus shows contextWindow when active model has metadata", () => {
  const line = formatLlmStatus({
    activeProviderId: "openai-codex",
    activeModel: "gpt-5.5",
    activeModelContextWindow: 272_000,
    activeModelOutputTokenLimit: 32_000,
    providers: [],
  });
  expect(line).toContain("272,000");
});
```

Use the actual helper name and signature from `main-helpers.ts`.

- [ ] **Step 9: Run failing test**

```bash
cd apps/gateway && npx vitest run src/tui/main-helpers.loop24.test.ts -t "contextWindow"
```

Expected: FAIL.

- [ ] **Step 10: Implement the format change in `main-helpers.ts`**

In the relevant formatter, append contextWindow / outputTokenLimit when present, matching existing formatting.

- [ ] **Step 11: Verify TUI test passes**

```bash
cd apps/gateway && npx vitest run src/tui/main-helpers.loop24.test.ts
```

Expected: PASS.

- [ ] **Step 12: ChatModelPicker — failing test**

Add to `packages/mission-control-shared/src/components/ChatModelPicker.worker-e.test.tsx` (or the appropriate ChatModelPicker test file):

```typescript
it("shows active model contextWindow when LlmRuntimeConfig provides it", () => {
  // Render the picker with runtime config carrying activeModelContextWindow: 272_000.
  // Assert the rendered DOM contains the string "272,000" or "272K" near the active model row.
});
```

- [ ] **Step 13: Run failing test**

```bash
cd packages/mission-control-shared && npx vitest run src/components/ChatModelPicker.worker-e.test.tsx -t "contextWindow"
```

Expected: FAIL.

- [ ] **Step 14: Update `ChatModelPicker.tsx`**

In the active-model display block, conditionally render a small badge/tooltip:

```tsx
{runtime.activeModelContextWindow !== undefined && (
  <span className="text-xs text-muted-foreground" title="Catalog/probe context window">
    {formatContextWindow(runtime.activeModelContextWindow)}
  </span>
)}
```

Add a `formatContextWindow(n: number): string` helper that returns e.g. `"272K"` for 272_000, `"1M"` for 1_000_000. Match the picker's existing styling utilities.

- [ ] **Step 15: Run ChatModelPicker test**

```bash
cd packages/mission-control-shared && npx vitest run src/components/ChatModelPicker.worker-e.test.tsx
```

Expected: PASS.

- [ ] **Step 16: Run all touched packages typecheck**

```bash
pnpm --filter @goatcitadel/gateway typecheck && pnpm --filter @goatcitadel/mission-control-shared typecheck
```

Expected: PASS.

- [ ] **Step 17: Commit**

```bash
git add apps/gateway/src/doctor/engine.ts apps/gateway/src/doctor/engine.test.ts apps/gateway/src/admin-cli.ts apps/gateway/src/admin-cli.integration.test.ts apps/gateway/src/tui/main-helpers.ts apps/gateway/src/tui/main-helpers.loop24.test.ts packages/mission-control-shared/src/components/ChatModelPicker.tsx packages/mission-control-shared/src/components/ChatModelPicker.worker-e.test.tsx
git commit -m "feat(gateway,mc-shared): surface active model contextWindow on doctor, admin-cli, tui, ChatModelPicker"
```

---

## Task 8: Provider catalog refresh in `config/llm-providers.example.json`

**Files:**
- Modify: `config/llm-providers.example.json`
- Modify: `packages/contracts/src/provider-templates.ts` (update knownModels for openai-codex; rename kimi-k2.5→k2.6 entry; add xAI)
- Modify: `packages/contracts/src/provider-templates.test.ts` if expectations regress
- Possibly modify: `apps/gateway/src/services/llm-service.ts` if `defaultModelForProvider` lives there and lists kimi-k2.5

- [ ] **Step 1: Capture current example config tests**

```bash
grep -rn "kimi-k2\." packages/contracts apps/gateway/src config | head -20
```

Note every k2.5 reference. We will rename to k2.6 in lockstep.

- [ ] **Step 2: Failing test for new providers in example config**

Create `apps/gateway/src/services/llm-providers-example.catalog.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { LlmConfigFile } from "@goatcitadel/contracts";

describe("config/llm-providers.example.json catalog", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
  const config = JSON.parse(
    readFileSync(join(repoRoot, "config/llm-providers.example.json"), "utf8"),
  ) as LlmConfigFile;
  const ids = config.providers.map((p) => p.providerId);

  it("includes the xAI Grok API-key provider", () => {
    expect(ids).toContain("xai");
    const xai = config.providers.find((p) => p.providerId === "xai");
    expect(xai?.defaultModel).toBe("grok-4.3");
  });

  it("DeepSeek default model is deepseek-v4-pro", () => {
    const deepseek = config.providers.find((p) => p.providerId === "deepseek");
    expect(deepseek?.defaultModel).toBe("deepseek-v4-pro");
  });

  it("Moonshot Kimi default model is kimi-k2.6 (renamed from k2.5)", () => {
    const moonshot = config.providers.find((p) => p.providerId === "moonshot");
    expect(moonshot?.defaultModel).toBe("kimi-k2.6");
  });

  it("OpenAI Codex remains gpt-5.5", () => {
    const codex = config.providers.find((p) => p.providerId === "openai-codex");
    expect(codex?.defaultModel).toBe("gpt-5.5");
  });
});
```

(Calibrate `repoRoot` path during run.)

- [ ] **Step 3: Run to confirm it fails**

```bash
cd apps/gateway && npx vitest run src/services/llm-providers-example.catalog.test.ts
```

Expected: FAIL on xAI presence + deepseek-v4-pro + kimi-k2.6.

- [ ] **Step 4: Edit `config/llm-providers.example.json`**

Apply these changes:

1. Update `deepseek` provider's `defaultModel` from `deepseek-v4-flash` to `deepseek-v4-pro`.
2. Update `moonshot` provider's `defaultModel` from `kimi-k2.5` to `kimi-k2.6`.
3. Add a new `xai` provider entry (place alphabetically near other major providers):

```json
{
  "providerId": "xai",
  "label": "xAI Grok (API key)",
  "baseUrl": "https://api.x.ai/v1",
  "apiStyle": "openai-chat-completions",
  "defaultModel": "grok-4.3",
  "authMode": "api-key",
  "apiKeyEnv": "XAI_API_KEY"
}
```

(authMode=`api-key` is the default; the manifest's `thinking: "off"` clamp handles the reasoning-effort issue. If/when xAI OAuth is wired in code, a follow-up adds `xai-oauth` to `LlmProviderAuthMode`.)

- [ ] **Step 5: Update `packages/contracts/src/provider-templates.ts`**

Mirror the example config:
- `openai-codex` `knownModels` array: keep `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.4-pro`, `gpt-5.4-mini`. Remove `gpt-5.3-codex` and `gpt-5.2-codex` (stale per spec; ChatGPT now rejects).
- `moonshot` template: rename `kimi-k2.5`→`kimi-k2.6` everywhere (defaultModel + knownModels).
- `deepseek` template: change defaultModel to `deepseek-v4-pro`; ensure `knownModels` lists both `deepseek-v4-pro` and `deepseek-v4-flash`.
- Add new `xai` template:

```typescript
{
  providerId: "xai",
  label: "xAI Grok (API key)",
  baseUrl: "https://api.x.ai/v1",
  defaultModel: "grok-4.3",
  apiStyle: "openai-chat-completions",
  knownModels: ["grok-4.3", "grok-4.2", "grok-4-mini"],
},
```

- [ ] **Step 6: Update existing references**

```bash
grep -rn "kimi-k2\.5" --include="*.ts" --include="*.tsx" --include="*.json" .
```

For each remaining reference (test fixtures, command parser tests, etc.), update to `kimi-k2.6` UNLESS the test is specifically asserting backward compatibility — in that case keep it. Pay attention to `chat-model-command.test.ts` which uses `moonshot/kimi-k2`.

- [ ] **Step 7: Run the catalog test**

```bash
cd apps/gateway && npx vitest run src/services/llm-providers-example.catalog.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run contracts + gateway + mission-control test suites**

```bash
pnpm --filter @goatcitadel/contracts test && pnpm --filter @goatcitadel/gateway test --run -- src/services/llm-service.test.ts src/services/llm-providers-example.catalog.test.ts src/services/chat-model-command.test.ts
```

Expected: green. Any failures here are likely stale references to `kimi-k2.5` or `deepseek-v4-flash` — fix and re-run.

- [ ] **Step 9: Commit**

```bash
git add config/llm-providers.example.json packages/contracts/src/provider-templates.ts packages/contracts/src/provider-templates.test.ts apps/gateway/src/services/llm-providers-example.catalog.test.ts
# Also stage any test fixture updates that resulted from Step 6
git status --short
# Stage anything additional that was modified
git commit -m "feat(config,contracts): refresh provider catalog (xAI Grok, DeepSeek v4-pro, Kimi K2.6)"
```

---

## Task 9: ChatGPT Instant alias override (`openai/chat-latest`)

**Files:**
- Modify: `packages/contracts/src/provider-templates.ts`
- Possibly modify: `apps/gateway/src/services/llm-service.ts` (model aliasing in `resolveProvider` / `defaultModelForProvider`)

- [ ] **Step 1: Failing test**

Add to `packages/contracts/src/provider-templates.test.ts`:

```typescript
it("openai template recognizes chat-latest as a known model", () => {
  const tpl = providerTemplates.find((t) => t.providerId === "openai");
  expect(tpl?.knownModels).toContain("chat-latest");
});
```

- [ ] **Step 2: Run failing test**

```bash
cd packages/contracts && npx vitest run src/provider-templates.test.ts -t "chat-latest"
```

Expected: FAIL.

- [ ] **Step 3: Add `chat-latest` to openai knownModels in `provider-templates.ts`**

```typescript
knownModels: ["gpt-5.4", "gpt-5.4-mini", "gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini", "chat-latest"],
```

- [ ] **Step 4: Verify**

```bash
cd packages/contracts && npx vitest run src/provider-templates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/provider-templates.ts packages/contracts/src/provider-templates.test.ts
git commit -m "feat(contracts): list openai/chat-latest as ChatGPT Instant alias"
```

---

## Task 10: Full repo gates + verification report

**Files:** None modified. Verification only.

- [ ] **Step 1: Run full repo typecheck**

```bash
pnpm -r typecheck
```

Expected: PASS.

- [ ] **Step 2: Run full repo tests**

```bash
pnpm -r test
```

Expected: green, or matches the documented 22-failure baseline from the gateway-service-decomposition memory (no new failures introduced). If `pnpm -r test` is impractically slow, narrow to the affected packages:

```bash
pnpm --filter @goatcitadel/contracts test && pnpm --filter @goatcitadel/gateway test && pnpm --filter @goatcitadel/mission-control-shared test
```

- [ ] **Step 3: Run gateway smoke test**

```bash
pnpm smoke
```

Expected: PASS.

- [ ] **Step 4: Build**

```bash
pnpm -r build
```

Expected: PASS.

- [ ] **Step 5: Write verification report**

Create `docs/superpowers/plans/2026-05-15-model-contextwindow-truth-catalog-refresh.verification.md` documenting:

- Static evidence (which tests now exist and what they assert)
- Manual probe checklist for the user to run live (since live API calls were out of scope):
  - Switch active provider to `openai-codex`, run `pnpm gateway admin llm status` — confirm output shows `Context window: 272,000`.
  - Switch to `anthropic/claude-opus-4-7` — confirm `Context window: 1,000,000`.
  - Add a `xai` provider with `XAI_API_KEY` set; confirm `/status` shows `Context window: 1,000,000` for `grok-4.3`.
  - Force a compaction with `requested = 200_000` against a model whose `outputTokenLimit = 32_000`; verify the warning string in logs.
  - DeepSeek v4-pro tool-call → follow-up turn; observe whether empty `reasoning_content` placeholder causes failure (this is a separate fix that this PR does NOT implement; track as a follow-up).

- [ ] **Step 6: Commit the verification report**

```bash
git add docs/superpowers/plans/2026-05-15-model-contextwindow-truth-catalog-refresh.verification.md
git commit -m "docs: verification report for model-contextwindow-truth-catalog-refresh"
```

- [ ] **Step 7: Push branch & open PR**

```bash
git push -u origin goatrocity/jolly-allen-0fad0f
gh pr create --title "feat: model contextWindow truth + provider catalog refresh" --body "$(cat <<'EOF'
## Summary

- Add `contextWindow` / `outputTokenLimit` to `LlmModelRecord`, `LlmProviderSummary`, `LlmRuntimeConfig`
- Add `bedrock-messages` to `LlmApiStyle`
- New versioned manifest at `config/llm-model-metadata.json` (glob-pattern lookup)
- Wire metadata enrichment through `LlmService.listModels`/`previewModels`/`getRuntimeConfig`
- Pure `clampSummaryReserveTokens` helper + service method `clampActiveModelSummaryReserve`
- Surface active model contextWindow on doctor probe, admin-cli status, TUI status, Mission Control `ChatModelPicker`
- Refresh `config/llm-providers.example.json`: add xAI Grok, switch DeepSeek to v4-pro, rename Kimi K2.5→K2.6, add ChatGPT Instant alias `chat-latest`

## Test plan

- [x] Contracts unit tests (type assertions for new fields, manifest shape)
- [x] Gateway unit tests (manifest loader, clamp helper, LlmService decoration)
- [x] Doctor probe test (missing-metadata warning)
- [x] Admin-CLI integration test (status output includes contextWindow)
- [x] TUI helpers test (formatter includes contextWindow)
- [x] ChatModelPicker test (DOM renders contextWindow badge)
- [x] Provider catalog test (xAI present, DeepSeek v4-pro, Kimi K2.6, OpenAI Codex GPT-5.5)
- [ ] Live probe (manual; see verification report)
EOF
)" --base main
```

Expected: PR URL returned.

---

## Self-Review Notes

**Spec coverage** (mapped to user's six action items):

1. ✅ Add `contextWindow` + `outputTokenLimit` to `LlmModelRecord` — Task 1
2. ✅ Create model-metadata manifest — Task 3
3. ✅ `/status` displays correct contextWindow — Task 7 (doctor + admin-cli + tui + ChatModelPicker)
4. ✅ Compaction reserve clamp — Tasks 5 + 6 (helper + service wiring)
5. ✅ Provider catalog refresh — Tasks 8 + 9 (xAI, DeepSeek v4-pro, Kimi K2.6, chat-latest alias)
6. ✅ Audit transport split — Task 2 (`bedrock-messages` added)

**Out-of-scope deferred items** (explicit non-goals for this PR):

- DeepSeek v4-pro empty `reasoning_content` placeholder strip — needs adapter work in `llm-provider-adapter.ts`; tracked as follow-up.
- Actual Bedrock adapter implementation — only the enum is added; concrete transport will be a follow-up.
- xAI OAuth flow — not included; this plan only adds the API-key provider entry + manifest metadata, with OAuth wiring as follow-up.
- Live smoke probes against real APIs — cannot be performed from within this session; verification report lists them for the user.

**Placeholder scan:** all code blocks contain real types and concrete values. Where the actual constructor / probe shape differs from the plan's illustrative form, each task explicitly instructs the implementer to inspect existing code first and calibrate.

**Type consistency:** `contextWindow` / `outputTokenLimit` / `activeModelContextWindow` / `activeModelOutputTokenLimit` / `LlmModelMetadataEntry` / `LlmModelMetadataManifest` / `clampSummaryReserveTokens` / `ClampSummaryReserveResult` / `clampActiveModelSummaryReserve` — names are used consistently across all tasks.
