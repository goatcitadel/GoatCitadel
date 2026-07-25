import type { ExternalSourceAdapterId, ExternalSourceKind, ExternalSourceRecord } from "@goatcitadel/contracts";
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_SOURCE_ADAPTER_BINDINGS,
  EXTERNAL_SOURCE_ADAPTER_IDS,
  ExternalSourceAdapterRegistry,
  ExternalSourceAdapterRegistryError,
  externalSourceAdapterPolicyView,
  type ExternalSourceAdapter,
} from "./types.js";

describe("ExternalSourceAdapterRegistry", () => {
  it("freezes exactly the four v1 adapter-to-kind bindings", () => {
    expect(EXTERNAL_SOURCE_ADAPTER_IDS).toEqual([
      "codex.rollout-jsonl.v1",
      "codex.memory-markdown.v1",
      "claude.project-jsonl.v1",
      "claude.memory-markdown.v1",
    ]);
    expect(EXTERNAL_SOURCE_ADAPTER_BINDINGS).toEqual({
      "codex.rollout-jsonl.v1": "codex_sessions",
      "codex.memory-markdown.v1": "codex_memory",
      "claude.project-jsonl.v1": "claude_sessions",
      "claude.memory-markdown.v1": "claude_memory",
    });
  });

  it("resolves only an exact adapter, kind, and version binding", () => {
    const adapters = allAdapters();
    const registry = new ExternalSourceAdapterRegistry(adapters);
    for (const adapter of adapters) {
      expect(registry.requireForSource(source(adapter.adapterId, adapter.sourceKind))).toBe(adapter);
    }
  });

  it("fails closed when any fixed adapter is absent", () => {
    expectRegistryCode(() => new ExternalSourceAdapterRegistry(allAdapters().slice(0, -1)), "incomplete_registry");
  });

  it("fails closed on duplicates, unsupported IDs, and invalid implementation shapes", () => {
    const adapters = allAdapters();
    expectRegistryCode(
      () => new ExternalSourceAdapterRegistry([...adapters.slice(0, -1), adapters[0] as ExternalSourceAdapter]),
      "duplicate_adapter",
    );
    expectRegistryCode(
      () =>
        new ExternalSourceAdapterRegistry([
          ...adapters.slice(0, -1),
          adapter("future.adapter.v9" as ExternalSourceAdapterId, "claude_memory"),
        ]),
      "invalid_adapter",
    );
    expectRegistryCode(
      () =>
        new ExternalSourceAdapterRegistry([
          ...adapters.slice(0, -1),
          adapter("claude.memory-markdown.v1", "codex_memory"),
        ]),
      "invalid_adapter",
    );
  });

  it("fails closed when configured kind, ID, or version drifts", () => {
    const registry = new ExternalSourceAdapterRegistry(allAdapters());
    expectRegistryCode(
      () => registry.requireForSource(source("codex.rollout-jsonl.v1", "claude_sessions")),
      "kind_mismatch",
    );
    expectRegistryCode(
      () => registry.requireForSource(source("unknown.adapter.v1" as ExternalSourceAdapterId, "codex_sessions")),
      "missing_adapter",
    );
    expectRegistryCode(
      () =>
        registry.requireForSource({
          ...source("codex.rollout-jsonl.v1", "codex_sessions"),
          adapterVersion: "different-version",
        }),
      "version_mismatch",
    );
  });

  it("hands adapters only an immutable parsing-policy projection, never the absolute source root", () => {
    const configured = {
      ...source("codex.rollout-jsonl.v1", "codex_sessions"),
      canonicalRootPath: "C:\\Users\\operator\\.codex",
      ownerActorId: "actor-1",
      adapterPolicy: {
        unknownVariantDisposition: "block",
        followLinks: false,
        followMarkdownImports: false,
        retainRawBytes: false,
        acceptedProducerVersions: ["synthetic-v1"],
      },
    } as ExternalSourceRecord;

    const view = externalSourceAdapterPolicyView(configured);
    expect(view).toEqual(configured.adapterPolicy);
    expect("canonicalRootPath" in view).toBe(false);
    expect("ownerActorId" in view).toBe(false);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.acceptedProducerVersions)).toBe(true);
    configured.adapterPolicy.acceptedProducerVersions.push("mutated");
    expect(view.acceptedProducerVersions).toEqual(["synthetic-v1"]);
  });
});

function allAdapters(): ExternalSourceAdapter[] {
  return EXTERNAL_SOURCE_ADAPTER_IDS.map((adapterId) =>
    adapter(adapterId, EXTERNAL_SOURCE_ADAPTER_BINDINGS[adapterId]),
  );
}

function adapter(adapterId: ExternalSourceAdapterId, sourceKind: ExternalSourceKind): ExternalSourceAdapter {
  return {
    adapterId,
    sourceKind,
    adapterVersion: "1.0.0",
    recognizes: () => false,
    inspect: async () => {
      throw new Error("Synthetic adapter does not parse formats.");
    },
    normalize: async () => {
      throw new Error("Synthetic adapter does not normalize formats.");
    },
  };
}

function source(adapterId: ExternalSourceAdapterId, kind: ExternalSourceKind): ExternalSourceRecord {
  return { adapterId, adapterVersion: "1.0.0", kind } as ExternalSourceRecord;
}

function expectRegistryCode(operation: () => unknown, code: ExternalSourceAdapterRegistryError["code"]): void {
  try {
    operation();
    throw new Error(`Expected external source adapter registry error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalSourceAdapterRegistryError);
    expect((error as ExternalSourceAdapterRegistryError).code).toBe(code);
  }
}
