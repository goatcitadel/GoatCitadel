import { createHash } from "node:crypto";
import { vi, type Mock } from "vitest";
import {
  ConflictError,
  parsePluginManifest,
  type CapabilityPluginInspection,
  type CapabilityPluginPieceView,
  type ChangePlanRecord,
  type DeploymentProfile,
  type HookCreateInput,
  type McpServerCreateInput,
  type McpServerRecord,
  type McpServerTemplateRecord,
} from "@goatcitadel/contracts";
import { ChangePlanRepository, createDatabase } from "@goatcitadel/storage";
import { CapabilityPluginActionsService } from "./capability-plugin-actions-service.js";
import {
  CapabilityPluginStore,
  type CapabilityPluginSettingRecord,
  type CapabilityPluginSettingRows,
} from "./capability-plugin-store.js";
import { EvolutionControlPlaneAdapterRegistry } from "./evolution-control-plane-adapter.js";
import { EvolutionControlPlaneService, type EvolutionControlPlaneActor } from "./evolution-control-plane-service.js";
import { allowsOperatorApprovalSkip } from "./operator-approval-skip.js";
import { PluginInstallChangePlanAdapter, type PluginInstallSources } from "./plugin-install-change-plan-adapter.js";
import { PluginSnapshotChangedError } from "./plugin-snapshot-store.js";

// One plugin install over the real Change Plan control plane, on a migrated SQLite ledger, with the plugin store's real
// compare-and-set rules and every other owner kept in memory. Shared by the adapter's and the actions service's tests.

export const PLUGIN_ID = "meeting-tools";
export const WORKSPACE_ID = "default";
export const INSPECTION_ID = "4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f";
export const TREE_SHA256 = "a".repeat(64);
export const OPERATOR: EvolutionControlPlaneActor = {
  workspaceId: WORKSPACE_ID,
  actorId: "operator-1",
  surface: "capabilities",
};

const POLICY = {
  requireFirstToolApproval: true,
  redactionMode: "basic" as const,
  allowedToolPatterns: [],
  blockedToolPatterns: [],
};

export const ISSUES_TEMPLATE: McpServerTemplateRecord = {
  templateId: "issues",
  label: "Issues",
  description: "Issues for tests.",
  transport: "http",
  url: "https://mcp.issues.test/mcp",
  authType: "oauth2",
  oauth: { metadataDiscovery: true },
  category: "data",
  trustTier: "restricted",
  costTier: "unknown",
  policy: POLICY,
  enabledByDefault: false,
  networkHosts: ["mcp.issues.test"],
};

export const CHECKS_MD = [
  "# Meeting checks",
  "",
  "Pack-Version: Meeting checks",
  "",
  "# Chat",
  "",
  "## No Tools",
  "",
  "### TEST-C901: Summary",
  "",
  "Summarize.",
  "",
].join("\n");

/** Every piece kind, in the order the install takes them up. */
export const FULL_MANIFEST = {
  schemaVersion: 1,
  pluginId: PLUGIN_ID,
  name: "Meeting tools",
  description: "Notes and checks for meetings.",
  version: "1.0.0",
  pieces: [
    { kind: "skill", id: "meeting-notes", path: "skills/meeting-notes" },
    { kind: "connector", id: "issues", templateId: "issues" },
    { kind: "tool_group_off", id: "no-browser", groupId: "browser" },
    { kind: "hook", id: "tool-watch", trigger: "tool.call.after", url: "https://hooks.example.com/goat" },
    { kind: "prompt_pack", id: "checks", path: "prompt-packs/checks.md" },
  ],
};

/** The views the inspection kept for `FULL_MANIFEST`. */
export function fullViews(): CapabilityPluginPieceView[] {
  return [
    {
      pieceId: "meeting-notes",
      kind: "skill",
      label: "meeting-notes",
      asksFirst: "Follows your tool rules.",
      check: { status: "ready" },
      skillSnapshotId: "snapshot-skill-1",
    },
    {
      pieceId: "issues",
      kind: "connector",
      label: "Issues",
      asksFirst: "Reading runs freely.",
      check: { status: "ready" },
      hosts: ["mcp.issues.test"],
    },
    {
      pieceId: "no-browser",
      kind: "tool_group_off",
      label: "Browser",
      asksFirst: "Turns Browser off.",
      check: { status: "ready" },
    },
    {
      pieceId: "tool-watch",
      kind: "hook",
      label: "After a tool call",
      asksFirst: "Sends event details.",
      check: { status: "ready" },
      hosts: ["hooks.example.com"],
      needsSecret: true,
    },
    {
      pieceId: "checks",
      kind: "prompt_pack",
      label: "Meeting checks",
      asksFirst: "Adds 1 test.",
      check: { status: "ready" },
    },
  ];
}

export interface PluginInstallFixture {
  manifest?: object;
  views?: CapabilityPluginPieceView[];
  files?: Record<string, string>;
  trust?: CapabilityPluginInspection["trust"];
  servers?: McpServerRecord[];
  allowlist?: string[];
  hookAllowlist?: string[];
  operatorOff?: string[];
  profile?: DeploymentProfile;
  /** The operator's skip setting; the deployment profile still decides first. */
  skip?: boolean;
  builtInIds?: string[];
}

/** One `system_settings` row with the repository's compare-and-set rule. */
export function settingRows(): CapabilityPluginSettingRows & { record?: CapabilityPluginSettingRecord } {
  let clock = 0;
  const rows: CapabilityPluginSettingRows & { record?: CapabilityPluginSettingRecord } = {
    get: async () => (rows.record ? structuredClone(rows.record) : undefined),
    compareAndSet: async (key, expected, value) => {
      if ((expected?.updatedAt ?? undefined) !== rows.record?.updatedAt) return undefined;
      rows.record = { key, value: structuredClone(value), updatedAt: String(++clock) };
      return structuredClone(rows.record);
    },
  };
  return rows;
}

export function pluginInstallHarness(input: PluginInstallFixture = {}) {
  const manifestText = JSON.stringify(input.manifest ?? FULL_MANIFEST, null, 2);
  const parsed = parsePluginManifest(manifestText);
  if (!parsed.ok) throw new Error(`The fixture manifest is refused: ${parsed.message}`);
  const now = Date.now();
  const inspection: CapabilityPluginInspection = {
    inspectionId: INSPECTION_ID,
    workspaceId: WORKSPACE_ID,
    pluginId: parsed.manifest.pluginId,
    name: parsed.manifest.name,
    description: parsed.manifest.description,
    version: parsed.manifest.version,
    trust: input.trust ?? "built_in",
    sourceKind: input.trust === "unverified" ? "git" : "built_in",
    sourceDisplay: input.trust === "unverified" ? "github.com/example/meeting-tools" : "Ships with GoatCitadel",
    pin: { kind: "content", treeSha256: TREE_SHA256 },
    manifestSha256: parsed.manifestSha256,
    pieces: input.views ?? fullViews(),
    ignored: [],
    installable: true,
    inspectedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
  };
  const rows = settingRows();
  const store = new CapabilityPluginStore(rows);
  const state = {
    inspection,
    manifestText,
    files: { "prompt-packs/checks.md": CHECKS_MD, ...input.files } as Record<string, string>,
    tampered: false,
    servers: [...(input.servers ?? [])],
    settings: {
      revision: 1,
      networkAllowlist: [...(input.allowlist ?? [])],
      hookAllowlist: [...(input.hookAllowlist ?? [])],
    },
    operatorOff: [...(input.operatorOff ?? [])],
    hooks: [] as HookCreateInput[],
    packs: [] as Array<{ packId: string; name: string; sourceLabel: string; content: string; revision: string }>,
    keychain: new Map<string, string>(),
    deletedSecrets: [] as string[],
    order: [] as string[],
    failAt: undefined as string | undefined,
  };
  const step = (name: string) => {
    state.order.push(name);
    if (state.failAt === name)
      throw new Error(`The ${name} owner failed at C:\\goat\\data with token sk-test-0123456789abcdef.`);
  };
  const sources = {
    readInspection: vi.fn(async (inspectionId: string) =>
      inspectionId === state.inspection.inspectionId && Date.parse(state.inspection.expiresAt) > Date.now()
        ? { inspection: structuredClone(state.inspection), snapshotTreeSha256: TREE_SHA256 }
        : undefined,
    ),
    readPlugin: vi.fn((pluginId: string) => store.get(pluginId)),
    updatePlugin: vi.fn((pluginId: string, change: Parameters<CapabilityPluginStore["update"]>[1]) =>
      store.update(pluginId, change),
    ),
    verifySnapshot: vi.fn(async (treeSha256: string) => {
      if (treeSha256 !== TREE_SHA256 || state.tampered) throw new PluginSnapshotChangedError();
    }),
    readManifest: vi.fn(async (_treeSha256: string) => parsePluginManifest(state.manifestText)),
    readSnapshotText: vi.fn(async (_treeSha256: string, relativePath: string) => {
      const text = state.files[relativePath];
      if (text === undefined) throw new Error(`No ${relativePath} in the snapshot.`);
      return text;
    }),
    connectorTemplates: () => [ISSUES_TEMPLATE],
    listSavedConnectors: vi.fn(async () => [...state.servers]),
    readSettings: vi.fn(async () => ({
      revision: state.settings.revision,
      networkAllowlist: [...state.settings.networkAllowlist],
      deploymentProfile: input.profile ?? ("local_dev" as const),
    })),
    readHookAllowlist: () => [...state.settings.hookAllowlist],
    updateSettings: vi.fn(
      async (update: { expectedRevision: number; networkAllowlist?: string[]; hookNetworkAllowlist?: string[] }) => {
        step("settings");
        if (update.expectedRevision !== state.settings.revision) {
          throw new ConflictError({ code: "WRITE_CONFLICT", message: "Settings changed elsewhere." });
        }
        state.settings = {
          revision: state.settings.revision + 1,
          networkAllowlist: update.networkAllowlist ?? state.settings.networkAllowlist,
          hookAllowlist: update.hookNetworkAllowlist ?? state.settings.hookAllowlist,
        };
      },
    ),
    createConnector: vi.fn(async (create: McpServerCreateInput, owner: NonNullable<McpServerRecord["pluginOwner"]>) => {
      step("connector");
      const server: McpServerRecord = {
        serverId: `server-${state.servers.length + 1}`,
        label: create.label,
        transport: create.transport,
        url: create.url,
        authType: create.authType ?? "none",
        enabled: create.enabled ?? true,
        category: create.category ?? "data",
        trustTier: create.trustTier ?? "restricted",
        costTier: create.costTier ?? "unknown",
        policy: { ...POLICY, ...create.policy },
        status: "disconnected",
        pluginOwner: { ...owner },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.servers = [server, ...state.servers];
      return server;
    }),
    setConnectorApproval: vi.fn(
      async (
        server: McpServerRecord,
        approvalPosture: "reads_free" | "everything_asks",
        _pass: { pluginId: string; installPlanId: string },
        _actorId: string,
      ) => {
        step("connector_approval");
        const updated = { ...server, policy: { ...server.policy, approvalPosture } };
        state.servers = state.servers.map((item) => (item.serverId === server.serverId ? updated : item));
        return updated;
      },
    ),
    operatorSwitchedOffToolGroups: () => [...state.operatorOff],
    createHook: vi.fn(async (hook: HookCreateInput) => {
      step("hook");
      state.hooks.push(structuredClone(hook));
      return { hookId: `hook-${state.hooks.length}` };
    }),
    importPromptPack: vi.fn(
      async (
        pack: { content: string; name: string; sourceLabel: string; packId: string },
        guarded: { packKey: string; expectedDefinitionRevision: string },
      ) => {
        step("prompt_pack");
        if (guarded.packKey !== pack.packId) throw new Error("A plugin's pack is created only under its own id.");
        state.packs.push({ ...pack, revision: guarded.expectedDefinitionRevision });
        return { pack: { packId: pack.packId } };
      },
    ),
    deleteHookSecret: vi.fn((secretRef: string) => {
      state.deletedSecrets.push(secretRef);
      state.keychain.delete(secretRef);
    }),
    reportSecretsKept: vi.fn((_error: unknown) => undefined),
  } satisfies PluginInstallSources;

  const database = createDatabase({ dbPath: ":memory:" });
  const sync = new ChangePlanRepository(database);
  const adapter = new PluginInstallChangePlanAdapter(sources);
  let disposition: "approved" | "denied" | "pending" = "pending";
  const createApproval = vi.fn(async () => "approval-plugin-install");
  const plans = new EvolutionControlPlaneService({
    repository: {
      create: async (create) => sync.create(create),
      get: async (planId) => sync.get(planId),
      list: async (query) => sync.list(query),
      listActive: async (limit) => sync.listActive(limit),
      listAwaitingApproval: async (approvalId, limit) => sync.listAwaitingApproval(approvalId, limit),
      findByIdempotency: async (workspaceId, key) => sync.findByIdempotency(workspaceId, key),
      transition: async (planId, transition) => sync.transition(planId, transition),
    },
    adapters: new EvolutionControlPlaneAdapterRegistry([adapter]),
    // The Gateway's own rule: remote_hardened never skips, and otherwise the operator's setting decides.
    allowsOperatorApprovalSkip: () =>
      allowsOperatorApprovalSkip(input.profile ?? "local_dev", async () => input.skip ?? true),
    createApproval,
    getApprovalDisposition: async () => disposition,
  });
  let minted = 0;
  const storeHookSecret: Mock<(value: string) => string> = vi.fn((value: string) => {
    const ref = `keychain:goatcitadel:hook:00000000-0000-4000-8000-${String(++minted).padStart(12, "0")}`;
    state.keychain.set(ref, value);
    return ref;
  });
  const actions = new CapabilityPluginActionsService({
    changePlansEnabled: async () => true,
    findPlan: (actor, key) => plans.findByIdempotencyKey(actor, key),
    createPlan: (create) => plans.create(create),
    confirmPlan: (actor, plan, actionNonce) =>
      plans.confirm(actor, plan.planId, plan.revision, actionNonce, { operatorSettingsSave: true }),
    workspaceExists: async (workspaceId) => workspaceId === WORKSPACE_ID,
    readInspection: (inspectionId) => sources.readInspection(inspectionId),
    readPlugin: (pluginId) => store.get(pluginId),
    listBuiltInPluginIds: async () => input.builtInIds ?? [],
    verifySnapshot: (treeSha256) => sources.verifySnapshot(treeSha256),
    readManifest: (treeSha256) => sources.readManifest(treeSha256),
    storeHookSecret: (value) => storeHookSecret(value),
    deleteHookSecret: (secretRef) => sources.deleteHookSecret(secretRef),
  });

  const pluginRequest = (hookSecretRefs?: Record<string, string>) => ({
    kind: "plugin_install" as const,
    inspectionId: INSPECTION_ID,
    manifestSha256: parsed.manifestSha256,
    snapshotTreeSha256: TREE_SHA256,
    workspaceId: WORKSPACE_ID,
    ...(hookSecretRefs ? { hookSecretRefs } : {}),
  });
  const confirm = (plan: ChangePlanRecord, actor: EvolutionControlPlaneActor = OPERATOR) =>
    plans.confirm(actor, plan.planId, plan.revision, plan.requiredAction!.actionNonce, { operatorSettingsSave: true });

  return {
    state,
    store,
    rows,
    sources,
    adapter,
    plans,
    actions,
    storeHookSecret,
    sync,
    database,
    createApproval,
    manifestSha256: parsed.manifestSha256,
    pluginRequest,
    confirm,
    /** Every row and event the ledger holds, as text, to look for a secret in. */
    ledgerText: () =>
      JSON.stringify([
        database.prepare("SELECT * FROM change_plans").all(),
        database.prepare("SELECT * FROM change_plan_events").all(),
        database.prepare("SELECT * FROM change_plan_links").all(),
      ]),
    approve: () => {
      disposition = "approved";
    },
    deny: () => {
      disposition = "denied";
    },
    close: () => database.close(),
  };
}

/** The SHA-256 a test expects a value to hash to. */
export function sha256Of(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
