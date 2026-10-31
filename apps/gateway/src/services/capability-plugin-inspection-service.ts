import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import {
  ConflictError,
  HOOK_TRIGGER_LABELS,
  HOOK_TRIGGER_VALUES,
  TOOL_GROUPS,
  ValidationError,
  canonicalJsonString,
  redactStructuredSecrets,
  type CapabilityPluginInspection,
  type CapabilityPluginPieceCheck,
  type CapabilityPluginPieceView,
  type McpServerTemplateRecord,
  type PluginManifest,
  type PluginManifestParse,
  type PluginPiece,
  type PluginPin,
  type PluginSource,
  type PluginTrust,
} from "@goatcitadel/contracts";
import type { CapabilityPluginInspectionRequestKey, StoredPlugin } from "./capability-plugin-store.js";
import { findInstallableConnectorTemplate, missingHosts } from "./connector-install-change-plan-adapter.js";
import { HostLookupError, HostNotPublicError, assertHostResolvesPublic } from "./hardened-git.js";
import { parseHookWebhookUrl } from "./hooks-service.js";
import { mcpServerLabelKey } from "./mcp-money-moving.js";
import { readPluginManifestFile } from "./plugin-manifest-file.js";
import {
  distinctPluginPromptPackNames,
  pluginPromptPackId,
  pluginPromptPackSourceLabel,
} from "./plugin-prompt-packs.js";
import { PluginSnapshotPathError } from "./plugin-snapshot-store.js";
import type { FetchedPluginSource } from "./plugin-source-service.js";
import { preparePromptPackImport } from "./prompt-pack/prepare-import.js";
import type { SkillHubPluginSkillInput } from "./skill-hub-plugin-skill-source.js";
import {
  SOURCE_REPLAY_CONFLICT,
  type SkillHubReviewResult,
  type SkillHubSourceReviewInput,
} from "./skill-hub-review-service.js";

// Inspecting a plugin: fetch its source into a snapshot, read its manifest, and check every piece with the check its
// own owner uses (the Skill Hub's review for a skill, the connector install's template rule, the tool switch's list,
// the hooks address rules and the prompt-pack parser). Nothing is installed: the only things kept are the snapshot,
// the Skill Hub's record of each skill's review, and the inspection itself.

/** How long an inspection can be installed from, and read back. */
export const INSPECTION_LIFETIME_MS = 24 * 60 * 60 * 1000;

export const ASKS_FIRST = {
  skill: "Follows your tool rules. Added after GoatCitadel's checks, then switched on.",
  connectorChanges: "Reading runs freely; creating or changing something asks first in Chat.",
  connectorEverything: "Everything it does asks first in Chat.",
  toolGroupOff: (groupLabel: string) => `Turns ${groupLabel} off in every chat while installed.`,
  hook: (host: string, triggerLabel: string) => `Sends event details, never message text, to ${host}: ${triggerLabel}.`,
  promptPack: (tests: number) =>
    `Adds ${tests} ${tests === 1 ? "test" : "tests"} to Library › Prompt packs. Nothing runs until you press Run.`,
  /** A prompt pack whose file couldn't be read: how many tests it holds isn't known. */
  unreadPromptPack: "Adds tests to Library › Prompt packs. Nothing runs until you press Run.",
} as const;

const SKILL_BLOCKED_MESSAGE = "This skill didn't pass GoatCitadel's checks.";
const SKILL_UNREADABLE_MESSAGE = "GoatCitadel can't check this skill.";
const KEY_REUSED_MESSAGE = "This request's key was already used for a different plugin check. Check it with a new key.";
const ANSWER_GONE_MESSAGE =
  "This plugin check is no longer kept, so its answer can't be sent again. Check the plugin again.";
const GROUP_NOT_SWITCHABLE_MESSAGE = "That group can't be switched off.";
const UNKNOWN_GROUP_MESSAGE = "GoatCitadel has no tool group with that id.";
const HOOK_URL_INVALID_MESSAGE = "That hook's address isn't a valid https address.";
const HOST_NOT_PUBLIC_MESSAGE = "That address isn't a public host.";
const HOST_NOT_FOUND_MESSAGE = "That address's host can't be found.";
const UNKNOWN_TRIGGER_MESSAGE = "GoatCitadel has no hook event with that name.";
const PROMPT_PACK_MISSING_MESSAGE = "The plugin doesn't have that prompt pack file.";
const PROMPT_PACK_NOT_TEXT_MESSAGE = "The prompt pack file isn't UTF-8 text.";
const PROMPT_PACK_INVALID_MESSAGE = "The prompt pack file isn't a prompt pack GoatCitadel can read.";
const PROMPT_PACK_TAKEN_MESSAGE = "Another prompt pack already uses the id this one needs.";
const PROMPT_PACK_VARIABLES_OFF_MESSAGE =
  "This prompt pack declares run variables, and typed run variables are switched off. A plugin can't switch them on.";
const BUILT_IN_ID_MISMATCH_MESSAGE = "This built-in plugin's manifest names a different plugin id.";
/** The review's own refusal codes are upper snake case, as the Skills tab's check reads them. */
const REVIEW_CODE = /^[A-Z][A-Z0-9_]*$/u;
/** Groups a plugin can never hold off. `mcp.invoke` is Core's own connector tool, named here so it can't slip past. */
const NEVER_SWITCHED_OFF: ReadonlySet<string> = new Set(["core", "mcp.invoke"]);
const READY: CapabilityPluginPieceCheck = { status: "ready" };
const ALREADY_THERE: CapabilityPluginPieceCheck = { status: "already_there" };

/** The request's logger. A refusal's cause, or a fault's detail, goes here and never into the answer. */
export interface CapabilityPluginInspectionLog {
  warn(details: Record<string, unknown>, message: string): void;
}

export interface CapabilityPluginInspectInput {
  workspaceId: string;
  source: PluginSource;
  /** Who asked, as the Skill Hub's review records it. */
  actorId: string;
  /**
   * The scope the Gateway's idempotency plugin holds this request's key under: the signed-in actor, or "" without
   * sign-in. The kept inspection is found by this same scope, so a retry the plugin calls answered finds its answer.
   */
  actorScope: string;
  /** The request's own key: the same key in the same scope gets the same answer while the inspection is kept. */
  idempotencyKey: string;
  log: CapabilityPluginInspectionLog;
  /** The request is a retry of one already answered: answer it again from the kept inspection, or refuse. */
  replayOnly?: boolean;
}

/** The settings an inspection reads, once. */
export interface CapabilityPluginInspectionSettings {
  /** The tool groups the operator has switched off. */
  switchedOffToolGroups: readonly string[];
  /** The hosts the network allowlist covers today. */
  networkAllowlist: readonly string[];
  /** Typed run variables (`typedRunVariablesV1Enabled`), which a prompt pack that declares run variables needs. */
  typedRunVariablesEnabled: boolean;
}

/** One reader per owner an inspection asks, each through its existing owner. None of them installs anything. */
export interface CapabilityPluginInspectionSources {
  /** `fetchPluginSource`, wired to the snapshot store. It throws `PluginSourceError` for a source it refuses. */
  fetchSource(source: PluginSource): Promise<FetchedPluginSource>;
  /** `PluginSnapshotStore.resolve`: a path inside a snapshot, or a plain `PluginSnapshotPathError`. */
  resolveSnapshotPath(treeSha256: string, relativePath: string): string;
  /** The Skill Hub's source review, the one the Skills tab's check runs. */
  reviewSkill(input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult>;
  /** The shipped connector catalog. */
  connectorTemplates(): readonly McpServerTemplateRecord[];
  /** The labels of the connectors already saved. */
  listSavedConnectorLabels(): Promise<readonly string[]>;
  /** The tool switches, the network allowlist and the typed run variables flag. */
  readSettings(): Promise<CapabilityPluginInspectionSettings>;
  /** Whether a prompt pack with this id is saved. */
  promptPackExists(packId: string): Promise<boolean>;
  /** Every address a host name resolves to. */
  lookupHost(hostname: string): Promise<Array<{ address: string }>>;
  /** The plugin store's record of an installed plugin. */
  findInstalled(pluginId: string): Promise<StoredPlugin | undefined>;
  /** The kept inspection that answered this key in this scope, with its request's fingerprint. */
  findKeptInspection(
    actorScope: string,
    idempotencyKey: string,
  ): Promise<{ inspection: CapabilityPluginInspection; payloadSha256: string } | undefined>;
  /** Keeps the inspection with the snapshot it read and the request it answered. */
  saveInspection(
    inspection: CapabilityPluginInspection,
    snapshotTreeSha256: string,
    request: CapabilityPluginInspectionRequestKey,
  ): Promise<void>;
  now(): Date;
  newInspectionId(): string;
  /**
   * The Gateway package's version, read once. A skill's review is keyed by it as well as by the copy, so review rules
   * that change with a release check each skill once more, and inspecting a copy again within a release replays.
   */
  gatewayVersion: string;
}

/** The manifest was refused. Its inspection is kept, with `refusal`, so it can be read back. */
export class CapabilityPluginManifestRefusedError extends Error {
  public constructor(
    public readonly inspection: CapabilityPluginInspection,
    /** Where in the manifest the problem is, such as `pieces[2].mode`. */
    public readonly field?: string,
  ) {
    super(inspection.refusal?.message ?? "The plugin's manifest was refused.");
    this.name = "CapabilityPluginManifestRefusedError";
  }
}

/** What every piece check of one inspection shares. The saved connectors and the settings are read once, when asked. */
interface InspectionContext {
  readonly input: CapabilityPluginInspectInput;
  readonly manifest: PluginManifest;
  readonly treeSha256: string;
  readonly trust: PluginTrust;
  readonly pin: PluginPin;
  /** This inspection's id, which a skill's fresh check is keyed by when its content key was superseded. */
  readonly inspectionId: string;
  readonly savedConnectorLabels: () => Promise<ReadonlySet<string>>;
  readonly settings: () => Promise<CapabilityPluginInspectionSettings>;
}

export class CapabilityPluginInspectionService {
  public constructor(private readonly sources: CapabilityPluginInspectionSources) {}

  /**
   * Inspects a plugin source. A key already used in this scope answers that inspection again while it is kept: the same
   * inspection, or the same manifest refusal; the key with another request is a 409. Otherwise it throws the source's
   * own `PluginSourceError` when the source can't be fetched, a `CapabilityPluginManifestRefusedError` (with its
   * inspection kept) when the manifest is refused, and a 409 when the plugin is already installed; then every piece is
   * checked in manifest order and the inspection is kept.
   */
  public async inspect(input: CapabilityPluginInspectInput): Promise<CapabilityPluginInspection> {
    const request: CapabilityPluginInspectionRequestKey = {
      actorScope: input.actorScope,
      idempotencyKey: input.idempotencyKey,
      payloadSha256: requestFingerprint(input),
    };
    const kept = await this.sources.findKeptInspection(request.actorScope, request.idempotencyKey);
    if (kept) {
      if (kept.payloadSha256 !== request.payloadSha256) {
        throw new ConflictError({ code: "STATE_CONFLICT", message: KEY_REUSED_MESSAGE });
      }
      return answerAgain(kept.inspection);
    }
    if (input.replayOnly) throw new ConflictError({ code: "STATE_CONFLICT", message: ANSWER_GONE_MESSAGE });

    const fetched = await this.sources.fetchSource(input.source);
    const parsed = refuseOtherBuiltInId(await readPluginManifestFile(fetched.snapshot.dir), input.source);
    const inspectedAt = this.sources.now();
    const frame = {
      inspectionId: this.sources.newInspectionId(),
      workspaceId: input.workspaceId,
      trust: fetched.trust,
      sourceKind: input.source.kind,
      sourceDisplay: fetched.sourceDisplay,
      pin: fetched.pin,
      ignored: [],
      inspectedAt: inspectedAt.toISOString(),
      expiresAt: new Date(inspectedAt.getTime() + INSPECTION_LIFETIME_MS).toISOString(),
    };
    if (!parsed.ok) {
      const refused: CapabilityPluginInspection = {
        ...frame,
        pluginId: "",
        name: "",
        description: "",
        version: "",
        manifestSha256: "",
        pieces: [],
        refusal: { code: parsed.code, message: parsed.message, ...(parsed.field ? { field: parsed.field } : {}) },
        installable: false,
      };
      await this.sources.saveInspection(refused, fetched.snapshot.treeSha256, request);
      return answerAgain(refused);
    }
    const { manifest, manifestSha256 } = parsed;
    const installed = await this.sources.findInstalled(manifest.pluginId);
    if (installed) {
      throw new ConflictError({
        code: "ALREADY_EXISTS",
        message: `${installed.name} is already installed.`,
        details: { pluginId: manifest.pluginId },
      });
    }

    const context: InspectionContext = {
      input,
      manifest,
      treeSha256: fetched.snapshot.treeSha256,
      trust: fetched.trust,
      pin: fetched.pin,
      inspectionId: frame.inspectionId,
      savedConnectorLabels: once(
        async () => new Set((await this.sources.listSavedConnectorLabels()).map((label) => mcpServerLabelKey(label))),
      ),
      settings: once(() => this.sources.readSettings()),
    };
    const checked: CapabilityPluginPieceView[] = [];
    // One at a time, in manifest order: a skill's review writes its own record, and the answer keeps that order.
    for (const piece of manifest.pieces) checked.push(await this.checkPiece(piece, context));
    const pieces = withDistinctPromptPackNames(checked);

    const inspection: CapabilityPluginInspection = {
      ...frame,
      pluginId: manifest.pluginId,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      ...(manifest.author ? { author: manifest.author } : {}),
      manifestSha256,
      pieces,
      installable: pieces.every((item) => item.check.status !== "blocked"),
    };
    await this.sources.saveInspection(inspection, fetched.snapshot.treeSha256, request);
    return inspection;
  }

  private checkPiece(piece: PluginPiece, context: InspectionContext): Promise<CapabilityPluginPieceView> {
    switch (piece.kind) {
      case "skill":
        return this.checkSkill(piece, context);
      case "connector":
        return this.checkConnector(piece, context);
      case "tool_group_off":
        return checkToolGroup(piece, context);
      case "hook":
        return checkHookPiece(piece, (hostname) => this.sources.lookupHost(hostname));
      case "prompt_pack":
        return this.checkPromptPack(piece, context);
    }
  }

  /**
   * The Skill Hub's own review of the skill's folder in the snapshot: ready, or blocked with its first code. The review
   * is keyed by the snapshot, the piece and the Gateway's version, so checking the same copy again on the same release
   * replays the same check. When that check came out differently because the review's rules changed within a release,
   * the skill is checked once more under a key of this inspection's own, and the earlier check stays as it is.
   */
  private async checkSkill(
    piece: Extract<PluginPiece, { kind: "skill" }>,
    context: InspectionContext,
  ): Promise<CapabilityPluginPieceView> {
    const { input } = context;
    const view = { pieceId: piece.id, kind: "skill" as const, asksFirst: ASKS_FIRST.skill };
    // The folder the review will read, as the snapshot store answers it: a path it refuses is a blocked piece.
    try {
      this.sources.resolveSnapshotPath(context.treeSha256, piece.path);
    } catch (error) {
      if (!(error instanceof PluginSnapshotPathError)) throw error;
      return { ...view, label: piece.id, check: blocked("PIECE_PATH_INVALID", error.message) };
    }
    const pluginSkill: SkillHubPluginSkillInput = {
      snapshotTreeSha256: context.treeSha256,
      path: piece.path,
      pluginId: context.manifest.pluginId,
      pieceId: piece.id,
      trust: context.trust,
      pinLabel: context.pin.kind === "commit" ? `commit:${context.pin.commit}` : `content:${context.pin.treeSha256}`,
    };
    const review = (idempotencyKey: string) =>
      this.sources.reviewSkill({ workspaceId: input.workspaceId, pluginSkill, idempotencyKey, actorId: input.actorId });
    const contentKey = `plugin:${context.treeSha256}:${piece.id}@${this.sources.gatewayVersion}`;
    let reviewed: SkillHubReviewResult;
    try {
      reviewed = await review(contentKey).catch((error: unknown) => {
        if (!isKeyBoundToOtherMaterial(error)) throw error;
        // This copy's earlier check came out differently, so the review's own rules or output changed since. Check it
        // once more under a key of this inspection's own; the earlier check stays as it is.
        const superseded = redactStructuredSecrets({ pieceId: piece.id, treeSha256: context.treeSha256 }).value;
        input.log.warn(superseded, "a plugin skill's content key was superseded by a fresh check");
        return review(`${contentKey}:${context.inspectionId}`);
      });
    } catch (error) {
      return { ...view, label: piece.id, check: skillRefusal(error, piece.id, input.log) };
    }
    const skillName = reviewed.snapshot.provenance.skillName;
    const blocker = reviewed.snapshot.blockerCodes[0];
    return {
      ...view,
      label: typeof skillName === "string" && skillName ? skillName : piece.id,
      check: blocker ? blocked(blocker, SKILL_BLOCKED_MESSAGE) : READY,
      skillSnapshotId: reviewed.snapshot.snapshotId,
    };
  }

  /**
   * The connector install's own template rule; a connector already saved under the template's label is kept. `hosts`
   * are the ones installing would add: the template's hosts the network allowlist doesn't cover yet.
   */
  private async checkConnector(
    piece: Extract<PluginPiece, { kind: "connector" }>,
    context: InspectionContext,
  ): Promise<CapabilityPluginPieceView> {
    const templates = this.sources.connectorTemplates();
    const view = {
      pieceId: piece.id,
      kind: "connector" as const,
      asksFirst: piece.asksFirst === "everything" ? ASKS_FIRST.connectorEverything : ASKS_FIRST.connectorChanges,
    };
    const found = findInstallableConnectorTemplate(templates, piece.templateId);
    if (!found.ok) {
      const label = templates.find((item) => item.templateId === piece.templateId)?.label ?? piece.templateId;
      return { ...view, label, check: blocked(found.field, found.message) };
    }
    const { template } = found;
    if ((await context.savedConnectorLabels()).has(mcpServerLabelKey(template.label))) {
      return { ...view, label: template.label, check: ALREADY_THERE };
    }
    const hosts = missingHosts(template, (await context.settings()).networkAllowlist);
    return { ...view, label: template.label, check: READY, ...(hosts.length > 0 ? { hosts } : {}) };
  }

  /**
   * The prompt-pack parser on the file, as a dry run, and a free `plugin-<pluginId>-<pieceId>` id. A pack that declares
   * run variables needs typed run variables on, which a plugin can't switch on.
   */
  private async checkPromptPack(
    piece: Extract<PluginPiece, { kind: "prompt_pack" }>,
    context: InspectionContext,
  ): Promise<CapabilityPluginPieceView> {
    const view = { pieceId: piece.id, kind: "prompt_pack" as const };
    const unread = (check: CapabilityPluginPieceCheck): CapabilityPluginPieceView => ({
      ...view,
      label: piece.id,
      asksFirst: ASKS_FIRST.unreadPromptPack,
      check,
    });
    let file: string;
    try {
      file = this.sources.resolveSnapshotPath(context.treeSha256, piece.path);
    } catch (error) {
      if (!(error instanceof PluginSnapshotPathError)) throw error;
      return unread(blocked("PIECE_PATH_INVALID", error.message));
    }
    const content = await readSnapshotText(file);
    if (typeof content !== "string") return unread(content);

    const packId = pluginPromptPackId(context.manifest.pluginId, piece.id);
    let prepared: ReturnType<typeof preparePromptPackImport>;
    try {
      // The label an install saves it under, so the name shown here is the name it gets.
      prepared = preparePromptPackImport({
        content,
        packId,
        sourceLabel: pluginPromptPackSourceLabel(context.manifest.name),
      });
    } catch (error) {
      // The parser's own words quote the file; the operator gets a plain line, and the detail stays in the log.
      warn(context.input.log, piece.id, error, "a plugin's prompt pack couldn't be read");
      return unread(blocked("PROMPT_PACK_INVALID", PROMPT_PACK_INVALID_MESSAGE));
    }
    const ready = {
      ...view,
      label: prepared.write.name,
      asksFirst: ASKS_FIRST.promptPack(prepared.write.tests.length),
    };
    if (prepared.hasDeclaredSchema && !(await context.settings()).typedRunVariablesEnabled) {
      return { ...ready, check: blocked("PROMPT_PACK_RUN_VARIABLES_OFF", PROMPT_PACK_VARIABLES_OFF_MESSAGE) };
    }
    const taken = await this.sources.promptPackExists(packId);
    return { ...ready, check: taken ? blocked("PROMPT_PACK_ID_TAKEN", PROMPT_PACK_TAKEN_MESSAGE) : READY };
  }
}

/**
 * A hook piece: the hooks owner's address rule (`parseHookWebhookUrl`, a valid https address), a trigger GoatCitadel
 * has, and a public host, the literal and every address a name resolves to. Installing adds the host to the hooks
 * allowlist, so that list isn't read here. Only a passing hook names its host in `hosts`. A failure of the check itself
 * (not a refusal) is a fault, as for every other piece.
 */
export async function checkHookPiece(
  piece: Extract<PluginPiece, { kind: "hook" }>,
  lookupHost: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<CapabilityPluginPieceView> {
  const triggerLabel = HOOK_TRIGGER_LABELS[piece.trigger] ?? piece.trigger;
  const view = { pieceId: piece.id, kind: "hook" as const, label: triggerLabel, needsSecret: true };
  let url: URL;
  try {
    url = parseHookWebhookUrl(piece.url);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    return {
      ...view,
      asksFirst: ASKS_FIRST.hook("its address", triggerLabel),
      check: blocked("HOOK_URL_INVALID", HOOK_URL_INVALID_MESSAGE),
    };
  }
  const asksFirst = ASKS_FIRST.hook(url.hostname, triggerLabel);
  if (!HOOK_TRIGGER_VALUES.includes(piece.trigger)) {
    return { ...view, asksFirst, check: blocked("UNKNOWN_HOOK_TRIGGER", UNKNOWN_TRIGGER_MESSAGE) };
  }
  try {
    await assertHostResolvesPublic(url, lookupHost);
  } catch (error) {
    if (error instanceof HostNotPublicError) {
      return { ...view, asksFirst, check: blocked("HOST_NOT_PUBLIC", HOST_NOT_PUBLIC_MESSAGE) };
    }
    if (error instanceof HostLookupError) {
      return { ...view, asksFirst, check: blocked("HOST_NOT_FOUND", HOST_NOT_FOUND_MESSAGE) };
    }
    throw error;
  }
  return { ...view, asksFirst, check: READY, hosts: [url.hostname] };
}

/** A switchable group from the Tools tab's own list; Core and `mcp.invoke` never. One already off is kept off. */
async function checkToolGroup(
  piece: Extract<PluginPiece, { kind: "tool_group_off" }>,
  context: InspectionContext,
): Promise<CapabilityPluginPieceView> {
  const group = TOOL_GROUPS.find((item) => item.id === piece.groupId);
  const label = group?.label ?? piece.groupId;
  const view = { pieceId: piece.id, kind: "tool_group_off" as const, label, asksFirst: ASKS_FIRST.toolGroupOff(label) };
  if (NEVER_SWITCHED_OFF.has(piece.groupId) || (group && !group.switchable)) {
    return { ...view, check: blocked("GROUP_NOT_SWITCHABLE", GROUP_NOT_SWITCHABLE_MESSAGE) };
  }
  if (!group) return { ...view, check: blocked("UNKNOWN_TOOL_GROUP", UNKNOWN_GROUP_MESSAGE) };
  const switchedOff = (await context.settings()).switchedOffToolGroups.includes(group.id);
  return { ...view, check: switchedOff ? ALREADY_THERE : READY };
}

/**
 * The review's refusal of a plugin's skill, as a blocked piece. Its code is kept when it is one of the review's own
 * codes; the review's words, which name the Skill Hub, are not. A refusal on `pluginSkill` is already plain and passes
 * through, and its cause (which can name folders) goes only to the server log. A conflict that reaches here (another
 * different-material conflict, on the fresh key the content key's own one was retried under, or any other) is a broken
 * invariant of the review, and like anything else it is a fault: logged, and answered as a plain 503 by the route.
 */
function skillRefusal(error: unknown, pieceId: string, log: CapabilityPluginInspectionLog): CapabilityPluginPieceCheck {
  if (error instanceof ValidationError) {
    const field = error.details?.field;
    if (field === "pluginSkill") {
      logCause(error, pieceId, log);
      return blocked("PLUGIN_SKILL_UNAVAILABLE", error.message);
    }
    if (field === "sourceRef") return blocked("SOURCE_REFUSED", SKILL_UNREADABLE_MESSAGE);
    if (typeof field === "string" && REVIEW_CODE.test(field)) return blocked(field, SKILL_BLOCKED_MESSAGE);
  }
  if (error instanceof ConflictError) {
    warn(log, pieceId, error, "a plugin's skill check broke");
    throw new Error("A plugin's skill check broke.", { cause: error });
  }
  throw error;
}

/**
 * The review's refusal of a key already bound to other material (`assertSourceReplay`): for a content key, this copy was
 * checked before and came out differently.
 */
function isKeyBoundToOtherMaterial(error: unknown): boolean {
  return error instanceof ConflictError && error.code === "WRITE_CONFLICT" && error.message === SOURCE_REPLAY_CONFLICT;
}

/**
 * A built-in plugin's manifest must name the folder it ships in, which is the id a built-in inspection asks for, as the
 * list of built-in plugins requires. Any other manifest, and any other answer, passes as it is.
 */
function refuseOtherBuiltInId(parsed: PluginManifestParse, source: PluginSource): PluginManifestParse {
  if (!parsed.ok || source.kind !== "built_in" || parsed.manifest.pluginId === source.pluginId) return parsed;
  return { ok: false, code: "MANIFEST_INVALID", message: BUILT_IN_ID_MISMATCH_MESSAGE, field: "pluginId" };
}

/**
 * The pieces with each prompt pack labelled by the name an install saves it under: two of the plugin's packs that would
 * share a name get one each (`distinctPluginPromptPackNames`, the install's own rule).
 */
function withDistinctPromptPackNames(pieces: readonly CapabilityPluginPieceView[]): CapabilityPluginPieceView[] {
  const names = distinctPluginPromptPackNames(
    pieces.filter((item) => item.kind === "prompt_pack").map((item) => ({ pieceId: item.pieceId, name: item.label })),
  );
  return pieces.map((item) =>
    item.kind === "prompt_pack" ? { ...item, label: names.get(item.pieceId) ?? item.label } : item,
  );
}

/** The kept answer again: the inspection, or its manifest refusal. */
function answerAgain(inspection: CapabilityPluginInspection): CapabilityPluginInspection {
  if (inspection.refusal) throw new CapabilityPluginManifestRefusedError(inspection, inspection.refusal.field);
  return inspection;
}

/** The SHA-256 of what a request asks for, so the same key can be told from a reused one. */
function requestFingerprint(input: Pick<CapabilityPluginInspectInput, "workspaceId" | "source">): string {
  return createHash("sha256")
    .update(canonicalJsonString({ workspaceId: input.workspaceId, source: input.source }))
    .digest("hex");
}

function logCause(error: Error, pieceId: string, log: CapabilityPluginInspectionLog): void {
  const cause = (error as { cause?: unknown }).cause;
  if (cause === undefined) return;
  warn(log, pieceId, cause, "a plugin's skill couldn't be reviewed");
}

/** An owner's own error, redacted, in the server log only. */
function warn(log: CapabilityPluginInspectionLog, pieceId: string, error: unknown, message: string): void {
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.warn({ pieceId, err: redactStructuredSecrets(diagnostic).value }, message);
}

/** A file in the snapshot as text, or the blocked check that says why it can't be read. */
async function readSnapshotText(file: string): Promise<string | CapabilityPluginPieceCheck> {
  let bytes: Buffer;
  try {
    // The snapshot holds only plain files within the plugin limits, so one read is bounded.
    if (!(await fs.lstat(file)).isFile()) return blocked("PROMPT_PACK_MISSING", PROMPT_PACK_MISSING_MESSAGE);
    bytes = await fs.readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return blocked("PROMPT_PACK_MISSING", PROMPT_PACK_MISSING_MESSAGE);
    throw error;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return blocked("PROMPT_PACK_NOT_TEXT", PROMPT_PACK_NOT_TEXT_MESSAGE);
  }
}

function blocked(code: string, message: string): CapabilityPluginPieceCheck {
  return { status: "blocked", code, message };
}

/** Runs `read` at most once, when first asked, and hands every caller the same answer. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= read());
}
