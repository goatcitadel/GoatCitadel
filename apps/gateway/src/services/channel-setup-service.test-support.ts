/**
 * An in-memory channel setup host for service tests: drafts, connections and secret custody kept in maps, with the
 * checks, live checks and diagnostics as mocks.
 */
import { vi } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import type { ChannelSetupHost } from "./channel-setup-service.js";
import { ChannelSecretCustodyService } from "./channel-secret-custody-service.js";

type DraftStore = {
  create: (input: Partial<ChannelSetupDraft> & Pick<ChannelSetupDraft, "catalogId">) => ChannelSetupDraft;
  get: (draftId: string) => ChannelSetupDraft;
  update: (draftId: string, patch: Partial<ChannelSetupDraft> & { expectedRevision: number }) => ChannelSetupDraft;
  delete: (draftId: string, expectedRevision?: number) => boolean;
  listByCatalog: (catalogId: string, limit: number) => ChannelSetupDraft[];
  listByConnection: (connectionId: string, limit: number) => ChannelSetupDraft[];
};

function createDraftStore(): DraftStore {
  const drafts = new Map<string, ChannelSetupDraft>();
  let sequence = 0;
  return {
    create(input) {
      const now = new Date().toISOString();
      const draftId = input.draftId ?? `draft-${++sequence}`;
      const draft: ChannelSetupDraft = {
        draftId,
        revision: 1,
        catalogId: input.catalogId,
        connectionId: input.connectionId,
        connectionRevision: input.connectionRevision,
        lifecycleMode: input.lifecycleMode ?? "create",
        label: input.label ?? "Draft",
        enabled: input.enabled ?? true,
        draft: input.draft ?? {},
        secretState: input.secretState ?? {},
        hydration: input.hydration,
        contentVersion: input.contentVersion ?? "test-content",
        adapterVersion: input.adapterVersion ?? "test-adapter",
        validationVersion: input.validationVersion ?? "test-validation",
        testVersion: input.testVersion ?? "test-version",
        createdAt: now,
        updatedAt: now,
        lastFailureCategory: input.lastFailureCategory,
        lastValidatedAt: input.lastValidatedAt,
        lastTestedAt: input.lastTestedAt,
      };
      drafts.set(draftId, draft);
      return draft;
    },
    get(draftId) {
      const draft = drafts.get(draftId);
      if (!draft) {
        throw new Error(`Missing draft ${draftId}`);
      }
      return draft;
    },
    update(draftId, patch) {
      const current = this.get(draftId);
      if (patch.expectedRevision !== current.revision) throw new Error("stale draft");
      const updated = {
        ...current,
        ...patch,
        revision: current.revision + 1,
        draft: patch.draft ? { ...patch.draft } : current.draft,
        secretState: patch.secretState ? { ...patch.secretState } : current.secretState,
        updatedAt: new Date().toISOString(),
      };
      drafts.set(draftId, updated);
      return updated;
    },
    delete(draftId, expectedRevision) {
      if (expectedRevision !== this.get(draftId).revision) throw new Error("stale draft");
      return drafts.delete(draftId);
    },
    listByCatalog(catalogId, limit) {
      return [...drafts.values()].filter((item) => item.catalogId === catalogId).slice(0, limit);
    },
    listByConnection(connectionId, limit) {
      return [...drafts.values()].filter((item) => item.connectionId === connectionId).slice(0, limit);
    },
  };
}

export function createChannelSetupTestHost(): ChannelSetupHost & {
  createConnectionMock: ReturnType<typeof vi.fn>;
  updateConnectionMock: ReturnType<typeof vi.fn>;
  diagnostics: ReturnType<typeof vi.fn>;
} {
  const draftStore = createDraftStore();
  const connections = new Map<string, IntegrationConnection>();
  const diagnostics = vi.fn();
  const secretValues = new Map<string, string>();
  const channelSecrets = new ChannelSecretCustodyService({
    setSecret: (account: string, value: string) => void secretValues.set(account, value),
    getSecret: (account: string) => secretValues.get(account),
    deleteSecret: (account: string) => void secretValues.delete(account),
  } as never);

  const createConnectionMock = vi.fn(
    (input: {
      connectionId?: string;
      catalogId: string;
      label: string;
      enabled: boolean;
      status: IntegrationConnection["status"];
      config: Record<string, unknown>;
    }) => {
      const connectionId = input.connectionId ?? `connection-${connections.size + 1}`;
      const connection: IntegrationConnection = {
        connectionId,
        revision: "a".repeat(64),
        catalogId: input.catalogId,
        kind: "channel",
        key: input.catalogId.replace("channel.", ""),
        label: input.label,
        enabled: input.enabled,
        status: input.status,
        config: input.config,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      connections.set(connectionId, connection);
      return connection;
    },
  );

  const updateConnectionMock = vi.fn((connectionId: string, patch: Partial<IntegrationConnection>) => {
    const current = connections.get(connectionId);
    if (!current) {
      throw new Error(`Unknown connection ${connectionId}`);
    }
    const updated: IntegrationConnection = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    connections.set(connectionId, updated);
    return updated;
  });

  return {
    storage: {
      // Synchronous on purpose, so a test can read a draft without awaiting; the service awaits every call.
      channelSetupDrafts: draftStore as unknown as ChannelSetupHost["storage"]["channelSetupDrafts"],
    },
    recentChannelSetupTests: new Map(),
    async commitChannelSetupConnection(draftId, expectedRevision, input, onCommitted) {
      const draft = draftStore.get(draftId);
      if (draft.revision !== expectedRevision) throw new Error("stale draft");
      const connection = draft.connectionId
        ? updateConnectionMock(draft.connectionId, input)
        : createConnectionMock(input);
      draftStore.delete(draftId, expectedRevision);
      await onCommitted?.();
      return connection;
    },
    channelSecrets,
    async getIntegrationConnection(connectionId: string) {
      const connection = connections.get(connectionId);
      if (!connection) {
        throw new Error(`Unknown connection ${connectionId}`);
      }
      return connection;
    },
    buildIntegrationConnectionChecks: vi.fn(() => []),
    runIntegrationConnectionLiveChecks: vi.fn(async () => ({ checks: [] })),
    createIntegrationConnection: async (input) => createConnectionMock(input),
    updateIntegrationConnection: async (connectionId, patch) => updateConnectionMock(connectionId, patch),
    recordDevDiagnostic: diagnostics,
    createConnectionMock,
    updateConnectionMock,
    diagnostics,
  };
}
