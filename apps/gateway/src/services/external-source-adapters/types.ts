import type {
  ExternalSourceAdapterId,
  ExternalSourceAdapterPolicy,
  ExternalSourceCatalogDisposition,
  ExternalSourceCatalogItem,
  ExternalSourceKind,
  ExternalSourceRecord,
} from "@goatcitadel/contracts";
import type { ExternalSourceReadResult } from "../external-source-reader.js";

export const EXTERNAL_SOURCE_ADAPTER_BINDINGS = Object.freeze({
  "codex.rollout-jsonl.v1": "codex_sessions",
  "codex.memory-markdown.v1": "codex_memory",
  "claude.project-jsonl.v1": "claude_sessions",
  "claude.memory-markdown.v1": "claude_memory",
} as const satisfies Readonly<Record<ExternalSourceAdapterId, ExternalSourceKind>>);

export const EXTERNAL_SOURCE_ADAPTER_IDS = Object.freeze(
  Object.keys(EXTERNAL_SOURCE_ADAPTER_BINDINGS) as ExternalSourceAdapterId[],
);

/**
 * Producer versions authorized by the frozen, secret-free compatibility
 * fixtures. Requests may narrow this set but can never add trust to it.
 * Real producer versions remain unsupported until an accepted fixture is
 * reviewed and this registry changes in code.
 */
export const EXTERNAL_SOURCE_FROZEN_COMPATIBILITY_VERSIONS = Object.freeze({
  "codex.rollout-jsonl.v1": Object.freeze(["synthetic-codex.v1"]),
  "codex.memory-markdown.v1": Object.freeze(["unversioned-markdown.v1"]),
  "claude.project-jsonl.v1": Object.freeze(["synthetic-claude.v1"]),
  "claude.memory-markdown.v1": Object.freeze(["unversioned-markdown.v1"]),
} as const satisfies Readonly<Record<ExternalSourceAdapterId, readonly string[]>>);

export interface ExternalSourceAdapterInspection {
  foreignIdSha256: string;
  producerVersion?: string;
  messageCount: number;
  lineageNodeCount: number;
  lineageDepth: number;
  lineageSha256: string;
  disposition: ExternalSourceCatalogDisposition;
  reasonCodes: readonly string[];
}

export interface ExternalSourceAdapterNormalization {
  normalizedBytes: Uint8Array;
  normalizedArtifactSha256: string;
  normalizedByteCount: number;
  messageCount: number;
  lineageNodeCount: number;
  lineageDepth: number;
  lineageSha256: string;
}

export type ExternalSourceAdapterPolicyView = Readonly<
  Omit<ExternalSourceAdapterPolicy, "acceptedProducerVersions">
> & {
  readonly acceptedProducerVersions: readonly string[];
};

/**
 * Format adapters receive only bytes admitted by ExternalSourceReader plus the
 * bounded parsing policy and immutable catalog metadata. They do not receive an
 * ExternalSourceRecord (which contains the absolute root), filesystem paths,
 * repositories, memory services, skill catalogs, shells, or write-capable
 * ports.
 */
export interface ExternalSourceAdapter {
  readonly adapterId: ExternalSourceAdapterId;
  readonly sourceKind: ExternalSourceKind;
  readonly adapterVersion: string;

  recognizes(relativePath: string): boolean;
  inspect(input: {
    policy: ExternalSourceAdapterPolicyView;
    file: ExternalSourceReadResult;
    signal: AbortSignal;
  }): Promise<ExternalSourceAdapterInspection>;
  normalize(input: {
    policy: ExternalSourceAdapterPolicyView;
    catalogItem: ExternalSourceCatalogItem;
    file: ExternalSourceReadResult;
    signal: AbortSignal;
  }): Promise<ExternalSourceAdapterNormalization>;
}

export function externalSourceAdapterPolicyView(source: ExternalSourceRecord): ExternalSourceAdapterPolicyView {
  const policy = source.adapterPolicy;
  if (
    !policy ||
    policy.unknownVariantDisposition !== "block" ||
    policy.followLinks !== false ||
    policy.followMarkdownImports !== false ||
    policy.retainRawBytes !== false ||
    !Array.isArray(policy.acceptedProducerVersions) ||
    policy.acceptedProducerVersions.length > 64 ||
    new Set(policy.acceptedProducerVersions).size !== policy.acceptedProducerVersions.length ||
    policy.acceptedProducerVersions.some(
      (version, index) =>
        typeof version !== "string" ||
        !version ||
        version !== version.trim() ||
        version !== version.normalize("NFKC") ||
        containsAsciiControlCharacter(version) ||
        version.length > 128 ||
        (index > 0 && version.localeCompare(policy.acceptedProducerVersions[index - 1] ?? "") < 0),
    )
  ) {
    throw new ExternalSourceAdapterRegistryError("invalid_adapter");
  }
  return Object.freeze({
    unknownVariantDisposition: "block" as const,
    followLinks: false as const,
    followMarkdownImports: false as const,
    retainRawBytes: false as const,
    acceptedProducerVersions: Object.freeze([...policy.acceptedProducerVersions]),
  });
}

export type ExternalSourceAdapterRegistryErrorCode =
  | "duplicate_adapter"
  | "incomplete_registry"
  | "invalid_adapter"
  | "kind_mismatch"
  | "missing_adapter"
  | "version_mismatch";

const REGISTRY_MESSAGES: Readonly<Record<ExternalSourceAdapterRegistryErrorCode, string>> = Object.freeze({
  duplicate_adapter: "External source adapter registry contains a duplicate fixed adapter.",
  incomplete_registry: "External source adapter registry is missing a required fixed adapter.",
  invalid_adapter: "External source adapter is invalid or unsupported.",
  kind_mismatch: "External source adapter does not match the configured source kind.",
  missing_adapter: "External source adapter is not registered.",
  version_mismatch: "External source adapter version does not match the configured source.",
});

export class ExternalSourceAdapterRegistryError extends Error {
  public constructor(public readonly code: ExternalSourceAdapterRegistryErrorCode) {
    super(REGISTRY_MESSAGES[code]);
    this.name = "ExternalSourceAdapterRegistryError";
  }
}

export class ExternalSourceAdapterRegistry {
  private readonly adapters = new Map<ExternalSourceAdapterId, ExternalSourceAdapter>();

  public constructor(adapters: readonly ExternalSourceAdapter[]) {
    if (!Array.isArray(adapters)) throw new ExternalSourceAdapterRegistryError("invalid_adapter");
    for (const adapter of adapters) {
      assertFixedAdapter(adapter);
      if (this.adapters.has(adapter.adapterId)) {
        throw new ExternalSourceAdapterRegistryError("duplicate_adapter");
      }
      this.adapters.set(adapter.adapterId, adapter);
    }
    if (this.adapters.size !== EXTERNAL_SOURCE_ADAPTER_IDS.length) {
      throw new ExternalSourceAdapterRegistryError("incomplete_registry");
    }
    for (const adapterId of EXTERNAL_SOURCE_ADAPTER_IDS) {
      if (!this.adapters.has(adapterId)) throw new ExternalSourceAdapterRegistryError("incomplete_registry");
    }
  }

  public requireForSource(source: ExternalSourceRecord): ExternalSourceAdapter {
    const adapterId = source.adapterId as string;
    if (!isFixedAdapterId(adapterId)) throw new ExternalSourceAdapterRegistryError("missing_adapter");
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new ExternalSourceAdapterRegistryError("missing_adapter");
    if (source.kind !== EXTERNAL_SOURCE_ADAPTER_BINDINGS[adapterId] || adapter.sourceKind !== source.kind) {
      throw new ExternalSourceAdapterRegistryError("kind_mismatch");
    }
    if (source.adapterVersion !== adapter.adapterVersion) {
      throw new ExternalSourceAdapterRegistryError("version_mismatch");
    }
    return adapter;
  }
}

function assertFixedAdapter(adapter: ExternalSourceAdapter): void {
  if (
    !adapter ||
    typeof adapter !== "object" ||
    !isFixedAdapterId(adapter.adapterId as string) ||
    EXTERNAL_SOURCE_ADAPTER_BINDINGS[adapter.adapterId] !== adapter.sourceKind ||
    typeof adapter.adapterVersion !== "string" ||
    !adapter.adapterVersion ||
    adapter.adapterVersion !== adapter.adapterVersion.trim() ||
    adapter.adapterVersion.length > 64 ||
    typeof adapter.recognizes !== "function" ||
    typeof adapter.inspect !== "function" ||
    typeof adapter.normalize !== "function"
  ) {
    throw new ExternalSourceAdapterRegistryError("invalid_adapter");
  }
}

function isFixedAdapterId(value: string): value is ExternalSourceAdapterId {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_SOURCE_ADAPTER_BINDINGS, value);
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
