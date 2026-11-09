import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  canonicalJsonString,
  ConflictError,
  isManagedProjectFileTool,
  projectManagedFileToolResult,
  readDurableChatTurnExecutionPayloadAuthority,
  type ChatAutoBinding,
  type DurableRunRecord,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import { ToolExecutionAlreadyClaimedError, type ToolExecutionRestriction } from "@goatcitadel/policy-engine";
import type { AsyncStorage } from "@goatcitadel/storage";
import { withCurrentChatApprovalAuthority, type ChatApprovalModeDependencies } from "./chat-approval-mode-service.js";
import { assertChatTurnToolUseOpen } from "./chat-turn-control.js";
import { executeManagedProjectFile, managedDeleteSchema, managedFileEffectId } from "./chat-managed-project-files.js";
import { resolveProjectRootForToolContext } from "./tool-path-resolution.js";

export interface ResolvedAutoAction {
  readonly toolName: string;
  readonly owner: "builtin" | "external" | "wrapper";
}

const reads = new Set([
  "fs.read",
  "fs.stat",
  "fs.list",
  "file.read_range",
  "file.find",
  "code.search",
  "code.search_files",
]);
const creates = new Set(["artifacts.create", "documents.create", "presentations.create"]);
const edits = new Set(["fs.write", "fs.patch", "fs.copy"]);
const deletions = new Set(["fs.delete", "fs.move", "fs.trash"]);
const reviewed = new Set([
  "channel.send",
  "channel.react",
  "channel.unsend",
  "gmail.send",
  "discord.send",
  "discord.react",
  "discord.unsend",
  "slack.send",
  "slack.react",
  "slack.unsend",
  "telegram.send",
  "telegram.react",
  "telegram.unsend",
  "calendar.create_event",
  "notify.request",
]);

export function classifyChatAutoAction(
  action: ResolvedAutoAction,
): "read_only" | "create" | "edit" | "delete" | "review" | "blocked" {
  if (action.owner !== "builtin") return "blocked";
  if (reads.has(action.toolName)) return "read_only";
  if (creates.has(action.toolName)) return "create";
  if (edits.has(action.toolName)) return "edit";
  if (deletions.has(action.toolName)) return "delete";
  if (reviewed.has(action.toolName)) return "review";
  return "blocked";
}

type Turn = { sessionId: string; turnId?: string; workspaceId?: string };
type Storage = ChatApprovalModeDependencies["storage"] &
  Pick<
    AsyncStorage,
    | "sessionMutationAdmissions"
    | "durableRuns"
    | "approvalEvents"
    | "approvals"
    | "pendingApprovalActions"
    | "chatTurnTraces"
    | "chatMessages"
    | "chatDelegationRuns"
    | "managedProjectFiles"
  >;

interface ExactDeleteTarget {
  readonly path: string;
  readonly identitySha256: string;
}

interface ScopedReadTarget {
  readonly projectRoot: string;
  readonly projectRootIdentitySha256: string;
  readonly path: string;
}

interface ChatAutoActionPolicyDependencies extends ChatApprovalModeDependencies {
  storage: Storage;
  rootDir: string;
  workspaceDir: string;
  /** The adapter must compare the retained identity and delete as one bounded transition. */
  deleteExactTarget?: (target: ExactDeleteTarget) => Record<string, unknown>;
  /** The adapter pins the project root and checks containment and read policy at every actual open, including traversal. */
  readScopedTarget?: (request: ToolInvokeRequest, target: ScopedReadTarget) => Promise<Record<string, unknown>>;
}

const blockedExecution = "Auto blocks execution whose effects the Gateway cannot verify.";
const staleTurn = "Chat approval mode or project changed. Start a new turn.";
const noExactDeletion = "This deletion needs a verified exact-target executor. No file was removed.";
const deletionReview = "Auto requires approval for this deletion.";
const deletionAlreadyClaimed = "This deletion was already attempted. Check the target before asking again.";

export class ChatAutoActionPolicy {
  private readonly executionScope = new AsyncLocalStorage<Turn>();

  constructor(private readonly deps: ChatAutoActionPolicyDependencies) {}

  async mode(turn: Turn): Promise<"standard" | "auto" | "stale"> {
    const explicit = await this.modeForExplicitTurn(turn);
    const ambient = this.executionScope.getStore();
    if (!ambient || sameTurnScope(turn, ambient)) return explicit;
    const inherited = await this.modeForExplicitTurn(ambient);
    if (explicit === "stale" || inherited === "stale") return "stale";
    return explicit === "auto" || inherited === "auto" ? "auto" : "standard";
  }

  private async modeForExplicitTurn(turn: Turn): Promise<"standard" | "auto" | "stale"> {
    return (
      (await this.withTurnAuthority(turn, async (binding) => (binding ? ("auto" as const) : ("standard" as const)))) ??
      "stale"
    );
  }

  runOutsideChatExecutionScope<T>(work: () => T): T {
    return this.executionScope.exit(work);
  }

  async inspect(
    request: ToolInvokeRequest,
    stage: "proposal" | "dispatch" | "replay",
    approvalId?: string,
  ): Promise<ToolExecutionRestriction | undefined> {
    const ambient = this.executionScope.getStore();
    if (ambient && !sameTurnScope(request, ambient)) {
      const inherited = await this.modeForExplicitTurn(ambient);
      if (inherited === "stale") return block(staleTurn);
      if (inherited === "auto") return block("Auto requires this tool to carry the current Chat turn scope.");
    }
    if (stage === "replay" && approvalId && request.toolName === "project.files.delete") {
      const receipt = await this.readRecoveredManagedDelete(request, approvalId);
      if (receipt)
        return {
          kind: "recovered_managed_delete",
          reason: "Recovered the committed managed file deletion.",
          result: receipt,
        };
    }
    const current = await this.withTurnAuthority(
      request,
      async (binding) => {
        if (!binding) {
          return {
            restriction: isManagedProjectFileTool(request.toolName)
              ? block("Managed project files require a bound Auto session.")
              : undefined,
          };
        }
        const owner = request.externalRuntime
          ? "external"
          : request.policyContext?.approvedCodeModeRunId
            ? "wrapper"
            : "builtin";
        if (isManagedProjectFileTool(request.toolName)) {
          return {
            restriction:
              owner === "builtin"
                ? await this.inspectManagedFile(request, binding, stage, approvalId)
                : block(blockedExecution),
          };
        }
        const action = classifyChatAutoAction({ toolName: request.toolName, owner });
        if (action === "blocked") return { restriction: block(blockedExecution) };
        if (action === "review")
          return {
            restriction: { kind: "review", reason: "Auto requires explicit approval for this action." } as const,
          };
        if (action === "delete" && stage === "replay" && approvalId && (await this.hasDeletionClaim(approvalId))) {
          return { restriction: { kind: "already_claimed", reason: deletionAlreadyClaimed } as const };
        }
        const project = await this.deps.storage.chatProjects.find(binding.projectId);
        const root = resolveProjectRootForToolContext({
          repoRoot: this.deps.rootDir,
          workspaceRoot: path.resolve(this.deps.rootDir, this.deps.workspaceDir),
          projectWorkspacePath: project?.workspacePath,
        });
        if (action === "read_only") {
          const { readScopedTarget } = this.deps;
          if (!readScopedTarget) return { restriction: block("Auto requires a verified project reader.") };
          const target = readScopedProjectTarget(root, request.args.path);
          return {
            restriction: target
              ? ({
                  kind: "read_scoped",
                  reason: "Auto verified this built-in project read.",
                  execute: () => readScopedTarget(request, target),
                } as const)
              : block("Auto reads must resolve inside the active project."),
          };
        }
        const targets =
          request.toolName === "fs.move" || request.toolName === "fs.copy"
            ? [request.args.from, request.args.to]
            : [request.args.path];
        if (!targets.every((target) => withinProject(root, target, false))) {
          return { restriction: block("Auto file actions must target the active project.") };
        }
        if (action !== "delete") {
          return { restriction: block("Auto requires a verified project file writer for this save.") };
        }
        const target =
          request.toolName === "fs.delete" &&
          request.turnId &&
          request.toolRunId &&
          (request.args.recursive === undefined || request.args.recursive === false)
            ? readExactDeleteTarget(request.args.path)
            : undefined;
        if (!target || !this.deps.deleteExactTarget) return { restriction: block(noExactDeletion) };
        if (stage !== "replay") {
          return {
            restriction: {
              kind: "review",
              reason: deletionReview,
              registration: { chatAutoDelete: deletionBinding(binding, request, target) },
            } as const,
          };
        }
        if (!approvalId) return { restriction: block(noExactDeletion) };
        const digest = deletionBinding(binding, request, target);
        if (!(await this.matchesDeletionApproval(approvalId, request, digest))) {
          return {
            restriction: block("This approval does not match the current deletion target or has already been used."),
          };
        }
        return {
          restriction: {
            kind: "execute_exact_delete",
            reason: "Auto verified the exact deletion approval.",
            execute: (policy: { reserve(): Promise<boolean>; revalidate(): Promise<boolean> }) =>
              this.executeExactDelete(request, approvalId, target, digest, policy),
          } as const,
        };
      },
      stage === "replay",
    );
    return current ? current.restriction : block(staleTurn);
  }

  private async inspectManagedFile(
    request: ToolInvokeRequest,
    binding: ChatAutoBinding,
    stage: "proposal" | "dispatch" | "replay",
    approvalId?: string,
  ): Promise<ToolExecutionRestriction> {
    if (!request.turnId || !request.toolRunId) return block("Managed project files require a durable tool call.");
    const { storage } = this.deps;
    const { managedProjectFiles: store } = storage;
    const effectId = managedFileEffectId("tool", binding.sessionId, request.turnId, request.toolRunId);
    if (request.toolName !== "project.files.delete") {
      if (!["project.files.list", "project.files.read", "project.files.save"].includes(request.toolName)) {
        return block("Unsupported managed file operation.");
      }
      return {
        kind: "execute_managed_file",
        reason: "Auto verified this managed project file operation.",
        execute: async (reserve) => {
          const result = await this.withTurnAuthority(
            request,
            async (current) => {
              if (!current || !(await reserve())) return undefined;
              await assertChatTurnToolUseOpen(storage, request.sessionId, request.turnId);
              request.signal?.throwIfAborted();
              return executeManagedProjectFile(
                store,
                { workspaceId: current.workspaceId, projectId: current.projectId },
                request.toolName,
                request.args,
                effectId,
              );
            },
            stage === "replay",
          );
          if (!result) throw new ConflictError({ message: "The managed workspace or tool policy changed." });
          return result;
        },
      };
    }
    if (stage === "replay" && approvalId && (await this.hasDeletionClaim(approvalId))) {
      return { kind: "already_claimed", reason: deletionAlreadyClaimed };
    }
    const parsed = managedDeleteSchema.safeParse(request.args);
    if (!parsed.success) return block("Managed deletion requires the file path and its exact current revision.");
    const input = parsed.data;
    const scope = { workspaceId: binding.workspaceId, projectId: binding.projectId };
    const target = { ...scope, path: input.path };
    const file = await store.read(target);
    if (!file || file.deleted || file.revisionId !== input.expectedRevision) {
      return block("The managed file or revision changed. Read it again before requesting deletion.");
    }
    const digest = deletionBinding(binding, request, { path: file.path, identitySha256: file.revisionId });
    if (stage !== "replay") {
      return { kind: "review", reason: deletionReview, registration: { chatAutoDelete: digest } };
    }
    if (!approvalId || !(await this.matchesDeletionApproval(approvalId, request, digest))) {
      return block("This approval does not match the current managed file revision.");
    }
    return {
      kind: "execute_exact_delete",
      reason: "Auto verified this exact managed file deletion.",
      execute: async (policy) => {
        const result = await this.withTurnAuthority(
          request,
          async (current) => {
            if (await this.hasDeletionClaim(approvalId)) {
              const recovered = await this.readRecoveredManagedDelete(request, approvalId);
              if (recovered) return recovered;
              throw new ToolExecutionAlreadyClaimedError(deletionAlreadyClaimed);
            }
            if (
              !current ||
              !(await this.matchesDeletionApproval(approvalId, request, digest)) ||
              !(await policy.reserve())
            ) {
              return undefined;
            }
            await assertChatTurnToolUseOpen(storage, request.sessionId, request.turnId);
            request.signal?.throwIfAborted();
            const receipt = await store.delete({ ...target, expectedRevision: input.expectedRevision, effectId });
            const result = { kind: "managed_project_file", ...receipt };
            await storage.approvalEvents.append({
              approvalId,
              actorId: "system",
              eventType: "replayed",
              payload: { chatAutoDeleteClaim: true, managedDeleteDigest: digest, managedDeleteReceipt: result },
            });
            return result;
          },
          true,
        );
        if (!result) throw new ConflictError({ message: "The managed deletion approval or policy changed." });
        return result;
      },
    };
  }

  private async readRecoveredManagedDelete(
    request: ToolInvokeRequest,
    approvalId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const events = await this.deps.storage.approvalEvents.listByApprovalId(approvalId);
    const committed = events.find(
      (event) =>
        event.eventType === "replayed" && event.actorId === "system" && event.payload.chatAutoDeleteClaim === true,
    );
    const digest = committed?.payload.managedDeleteDigest;
    const receipt = committed?.payload.managedDeleteReceipt;
    if (
      typeof digest !== "string" ||
      !receipt ||
      typeof receipt !== "object" ||
      Array.isArray(receipt) ||
      !(await this.matchesDeletionApproval(approvalId, request, digest, false))
    )
      return undefined;
    const projected = projectManagedFileToolResult(request.toolName, receipt as Record<string, unknown>);
    if (
      projected.deleted !== true ||
      projected.previousRevisionId !== request.args.expectedRevision ||
      projected.workspaceId !== request.workspaceId ||
      typeof projected.revisionId !== "string"
    )
      return undefined;
    // Recovery reports an already committed effect. It grants no ability to
    // execute under an expired approval or a changed session/project policy.
    return { ...projected, replayed: true };
  }

  async assertPlacementCurrent(run: DurableRunRecord): Promise<"standard" | "auto"> {
    const payload = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: run.runId,
      payload: run.payload,
    });
    if (!payload) throw new ConflictError({ message: staleTurn });
    if (
      (await this.deps.storage.sessionMutationAdmissions.findDurableRunIdForTurn(payload.sessionId, payload.turnId)) !==
      run.runId
    ) {
      throw new ConflictError({ message: staleTurn });
    }
    const mode = await this.modeForExplicitTurn(payload);
    if (mode === "stale") throw new ConflictError({ message: staleTurn });
    return mode;
  }

  async runInDurableTurn<T>(run: DurableRunRecord, work: () => Promise<T>): Promise<T> {
    const payload = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: run.runId,
      payload: run.payload,
    });
    if (!payload) throw new ConflictError({ message: staleTurn });
    const parent = this.executionScope.getStore();
    if (parent && (parent.sessionId !== payload.sessionId || parent.turnId !== payload.turnId)) {
      await this.assertNoDelegatedExecution(parent);
    }
    await this.assertPlacementCurrent(run);
    return this.executionScope.run(
      { sessionId: payload.sessionId, workspaceId: payload.workspaceId, turnId: payload.turnId },
      work,
    );
  }

  async assertNoDelegatedExecution(turn: Turn): Promise<void> {
    const mode = await this.mode(turn);
    if (mode === "stale") throw new ConflictError({ message: staleTurn });
    if (mode === "auto")
      throw new ConflictError({ message: "Auto keeps this turn local and blocks delegated execution." });
  }

  async blockOpaqueDispatch(turn: Turn): Promise<string | undefined> {
    const mode = await this.mode(turn);
    return mode === "stale" ? staleTurn : mode === "auto" ? blockedExecution : undefined;
  }

  private async withTurnAuthority<T>(
    turn: Turn,
    work: (binding?: ChatAutoBinding) => Promise<T>,
    linkedReplay = false,
  ): Promise<T | undefined> {
    const { storage } = this.deps;
    const runId = turn.turnId
      ? await storage.sessionMutationAdmissions.findDurableRunIdForTurn(turn.sessionId, turn.turnId)
      : undefined;
    if (!runId) {
      if (
        (turn.turnId || linkedReplay) &&
        (await storage.chatSessionPrefs.getApprovalMode(turn.sessionId))?.mode === "auto"
      ) {
        return undefined;
      }
      return work();
    }
    const run = await storage.durableRuns.getRun(runId);
    const payload = readDurableChatTurnExecutionPayloadAuthority({
      workflowKey: run.workflowKey,
      durableRunId: runId,
      payload: run.payload,
    });
    if (
      !payload ||
      payload.turnId !== turn.turnId ||
      payload.sessionId !== turn.sessionId ||
      (turn.workspaceId !== undefined && turn.workspaceId !== payload.workspaceId)
    )
      return undefined;
    return storage.runImmediateTransaction(async () => {
      // Take the canonical advisory and session locks before the project lock.
      await storage.sessionMutationAdmissions.requireExactDurableTurnPayloadIdentity({
        ...payload,
        durableRunId: runId,
      });
      const result = await withCurrentChatApprovalAuthority(this.deps, payload, async (current) =>
        work(current.mode === "auto" ? current.binding : undefined),
      );
      return result.status === "current" ? result.value : undefined;
    });
  }

  private async hasDeletionClaim(approvalId: string): Promise<boolean> {
    const events = await this.deps.storage.approvalEvents.listByApprovalId(approvalId);
    return events.some((event) => event.eventType === "replayed" && event.payload.chatAutoDeleteClaim === true);
  }

  private async matchesDeletionApproval(
    approvalId: string,
    request: ToolInvokeRequest,
    digest: string,
    fresh = true,
  ): Promise<boolean> {
    const { storage } = this.deps;
    const approval = await storage.approvals.get(approvalId);
    const pending = fresh
      ? await storage.pendingApprovalActions.findFreshPending(approvalId, 15 * 60_000)
      : await storage.pendingApprovalActions.find(approvalId);
    if (
      approval.status !== "approved" ||
      approval.kind !== request.toolName ||
      !pending ||
      pending.resolutionStatus !== "pending" ||
      pending.request.toolName !== request.toolName ||
      pending.request.agentId !== request.agentId ||
      !approval.resolvedBy ||
      pending.request.turnId !== request.turnId ||
      pending.request.toolRunId !== request.toolRunId ||
      pending.request.sessionId !== request.sessionId ||
      pending.request.workspaceId !== request.workspaceId ||
      canonicalJsonString(approval.payload) !== canonicalJsonString(request.args) ||
      approval.resolvedBy === "system" ||
      approval.resolvedBy.startsWith("system:")
    )
      return false;
    const events = await storage.approvalEvents.listByApprovalId(approvalId);
    return (
      events.some(
        (event) => event.eventType === "pending_action_registered" && event.payload.chatAutoDelete === digest,
      ) &&
      events.some(
        (event) =>
          event.eventType === "resolved" &&
          event.actorId === approval.resolvedBy &&
          event.payload.decision === "approve" &&
          event.payload.outcome === "approved",
      )
    );
  }

  private async executeExactDelete(
    request: ToolInvokeRequest,
    approvalId: string,
    target: ExactDeleteTarget,
    digest: string,
    policy: { reserve(): Promise<boolean>; revalidate(): Promise<boolean> },
  ): Promise<Record<string, unknown>> {
    const { storage, deleteExactTarget } = this.deps;
    if (!deleteExactTarget) throw new ConflictError({ message: noExactDeletion });
    const matches = (binding?: ChatAutoBinding) => {
      const current = readExactDeleteTarget(request.args.path);
      return binding && current && deletionBinding(binding, request, current) === digest;
    };
    // Persist consumption before the file transition. A crash after claim never replays the deletion.
    const claimed = await this.withTurnAuthority(request, async (binding) => {
      if (await this.hasDeletionClaim(approvalId)) throw new ToolExecutionAlreadyClaimedError(deletionAlreadyClaimed);
      if (
        request.signal?.aborted ||
        !matches(binding) ||
        !(await this.matchesDeletionApproval(approvalId, request, digest)) ||
        !(await policy.reserve())
      )
        return false;
      await storage.approvalEvents.append({
        approvalId,
        actorId: "system",
        eventType: "replayed",
        payload: { chatAutoDeleteClaim: true },
      });
      return true;
    });
    if (!claimed)
      throw new ConflictError({ message: "The deletion approval or target changed. Request a new approval." });
    const result = await this.withTurnAuthority(request, async (binding) => {
      if (
        request.signal?.aborted ||
        !matches(binding) ||
        !(await policy.revalidate()) ||
        !(await this.matchesDeletionApproval(approvalId, request, digest))
      )
        return undefined;
      await assertChatTurnToolUseOpen(storage, request.sessionId, request.turnId);
      request.signal?.throwIfAborted();
      return deleteExactTarget(target);
    });
    if (!result) throw new ConflictError({ message: "The deletion policy or target changed. Request a new approval." });
    return result;
  }
}

function sameTurnScope(left: Turn, right: Turn): boolean {
  return left.sessionId === right.sessionId && left.turnId === right.turnId && left.workspaceId === right.workspaceId;
}

function block(reason: string): ToolExecutionRestriction {
  return { kind: "block", reason };
}

function withinProject(root: string | undefined, target: unknown, existing: boolean): boolean {
  if (!root || typeof target !== "string" || target !== target.trim() || !path.isAbsolute(target)) return false;
  try {
    const project = fs.realpathSync.native(root);
    let candidate = path.resolve(target);
    // A reviewed write may target a new file, but even its nearest existing ancestor must be in scope.
    if (!existing) {
      while (!fs.existsSync(candidate)) {
        const parent = path.dirname(candidate);
        if (parent === candidate) return false;
        candidate = parent;
      }
    }
    const lexical = path.relative(root, target);
    const resolved = path.relative(project, fs.realpathSync.native(candidate));
    return [lexical, resolved].every(
      (relative) => relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    );
  } catch {
    return false;
  }
}

function readExactDeleteTarget(value: unknown): ExactDeleteTarget | undefined {
  if (typeof value !== "string" || value !== path.resolve(value)) return undefined;
  try {
    if (path.relative(value, fs.realpathSync.native(value)) !== "") return undefined;
    const stat = fs.lstatSync(value, { bigint: true });
    if ((!stat.isFile() && !stat.isDirectory()) || stat.ino === 0n) return undefined;
    return { path: value, identitySha256: fileIdentity(stat) };
  } catch {
    return undefined;
  }
}

function readScopedProjectTarget(root: string | undefined, target: unknown): ScopedReadTarget | undefined {
  if (!root || typeof target !== "string" || !withinProject(root, target, true)) return undefined;
  try {
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.ino === 0n) return undefined;
    return { projectRoot: root, projectRootIdentitySha256: fileIdentity(stat), path: target };
  } catch {
    return undefined;
  }
}

function fileIdentity(stat: fs.BigIntStats): string {
  const fields = [stat.dev, stat.ino, stat.mode, stat.size, stat.ctimeNs, stat.mtimeNs, stat.birthtimeNs];
  return createHash("sha256").update(fields.join(":"), "utf8").digest("hex");
}

function deletionBinding(binding: ChatAutoBinding, request: ToolInvokeRequest, target: ExactDeleteTarget): string {
  const { toolName, args, turnId, toolRunId, agentId } = request;
  return createHash("sha256")
    .update(canonicalJsonString({ binding, toolName, args, turnId, toolRunId, agentId, target }), "utf8")
    .digest("hex");
}
