import { open, readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { projectNativeRecoveryOutcome } from "./agent-comparison-native-recovery-evidence.mjs";
import { validateNativeRecoveryEffectObservation } from "./agent-comparison-native-recovery-binding.mjs";
import { sha256 } from "./agent-comparison.mjs";
import { FEATURE_ACCEPTANCE_TASKS } from "./agent-comparison-acceptance-fixtures.mjs";
import { readFeatureAcceptanceAvailability, FEATURE_ACCEPTANCE_PINS } from "./agent-comparison-acceptance-profile.mjs";
import {
  PERMISSION_REVIEW_FILE,
  PERMISSION_REVIEW_VERSION,
  normalizeComparisonPermissions,
} from "./agent-comparison-permissions.mjs";

export const requireNative = (value, message) => {
  if (!value) throw new Error(message);
};
export const nativeJson = (value) => {
  if (typeof value === "string") return JSON.parse(value);
  if (Array.isArray(value))
    return JSON.parse(
      value
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    );
  requireNative(false, "Native tool content has no JSON result.");
};
export const nativeTimestamp = (value) => {
  const date = typeof value === "number" ? new Date(value < 10_000_000_000 ? value * 1000 : value) : new Date(value);
  requireNative(Number.isFinite(date.getTime()), "Native result has no valid observation time.");
  return date.toISOString();
};

/** Shared custody only. Product modules below own parsing native messages and
 * joins; no synthetic generic result is accepted as product evidence. */
export async function createNativeWebAcceptance({
  product,
  project,
  readRecovery,
  session,
  manifest,
  options,
  supervisor,
}) {
  const taskId = options.cellId.split(":")[1];
  const profile = manifest.products[product];
  requireNative(
    session.binding.revision === FEATURE_ACCEPTANCE_PINS[product] && profile?.revision === session.binding.revision,
    "The adapter does not match its reviewed product revision.",
  );
  const availability = readFeatureAcceptanceAvailability(product, taskId, profile);
  if (availability.status !== "supported") return { availability, close: async () => supervisor?.stop?.() };
  requireNative(
    ["web_research", "provider_recovery"].includes(taskId) &&
      [
        "start",
        "runTurn",
        "stop",
        "reviewPermissions",
        ...(taskId === "web_research"
          ? ["reviewSources"]
          : ["armPreDispatchFailure", "observeProviderFault", "armUncertainEffect", "observeEffectTransport"]),
      ].every((key) => typeof supervisor?.[key] === "function"),
    "This native web journey requires the shipped owned-process and human-review supervisor.",
  );
  let runtime,
    sequence = 0,
    retainedBytes = 0,
    closed = false,
    current,
    primaryNative,
    uncertain,
    uncertainEvidence;
  const refs = [];
  const save = async (label, value) => {
    const name = `native-${product}-acceptance-${++sequence}.json`;
    requireNative(sequence <= 500, "The native receipt count exceeds the bound.");
    const bytes = Buffer.from(JSON.stringify({ label, ...session.binding, value }, null, 2) + "\n");
    retainedBytes += bytes.length;
    requireNative(
      bytes.length <= 4 * 1024 * 1024 && retainedBytes <= 40 * 1024 * 1024,
      "Native evidence exceeds its bound.",
    );
    const file = await open(path.join(session.evidence, name), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    refs.push({ path: name, sha256: sha256(bytes) });
  };
  const finish = (records) => ({ records, nativeReceipts: refs.splice(0) });
  const actions = {
    async run_turn({ signal }) {
      const task = FEATURE_ACCEPTANCE_TASKS.find((entry) => entry.id === taskId);
      const native = await supervisor.runTurn({ prompt: task.prompt, signal });
      await save("native-turn", native);
      if (taskId === "provider_recovery") {
        requireNative(typeof readRecovery === "function", "Use the pinned native recovery reader.");
        primaryNative = native;
        current = readRecovery(native, { model: profile.model, workspace: session.workspace, prompt: task.prompt });
        const fault = await supervisor.observeProviderFault({ runtimeId: runtime.runtimeId, signal });
        await save("controlled-provider-fault", fault);
        return finish(
          projectNativeRecoveryOutcome(current, {
            fault,
            runtimeId: runtime.runtimeId,
            observedAt: new Date().toISOString(),
          }).records,
        );
      }
      current = project(native, { model: profile.model, workspace: session.workspace, prompt: task.prompt });
      requireNative(current.records.length > 0, "Native web tools produced no retained source evidence.");
      return finish(current.records);
    },
    async arm_predispatch_failure({ signal }) {
      requireNative(taskId === "provider_recovery", "Faults require the recovery fixture.");
      const armed = await supervisor.armPreDispatchFailure({
        runtimeId: runtime.runtimeId,
        providerId: "comparison",
        signal,
      });
      await save("controlled-fault-armed", armed);
      return finish([
        { kind: "fault_armed", id: `${runtime.runtimeId}:fault`, at: new Date().toISOString(), ...armed },
      ]);
    },
    async run_uncertain_effect_case({ signal }) {
      requireNative(taskId === "provider_recovery" && current, "Complete the primary recovery observation first.");
      const setup = await supervisor.armUncertainEffect({ runtimeId: runtime.runtimeId, signal });
      await save("controlled-uncertain-setup", setup);
      const native = await supervisor.runTurn({ prompt: setup.prompt, signal });
      await save("native-uncertain-turn", native);
      uncertainEvidence = readRecovery(native, {
        model: profile.model,
        workspace: session.workspace,
        prompt: setup.prompt,
        ...(product === "hermes" ? { previous: primaryNative.transcript } : {}),
      });
      requireNative(
        uncertainEvidence.runId !== current.runId,
        "The uncertain case must be an independent native turn.",
      );
      const matches = uncertainEvidence.tools.filter(
        (tool) => tool.toolName === setup.toolName && tool.argsSha256 === setup.argsSha256,
      );
      requireNative(matches.length === 1, "The native uncertain case has no single exact nonce-bound tool call.");
      uncertain = {
        runId: uncertainEvidence.runId,
        turnId: uncertainEvidence.turnId,
        effectId: matches[0].effectId,
        toolName: setup.toolName,
        argsSha256: setup.argsSha256,
      };
      const observed = await supervisor.observeEffectTransport({ runtimeId: runtime.runtimeId, ...uncertain, signal });
      validateNativeRecoveryEffectObservation(observed, { runtimeId: runtime.runtimeId, ...uncertain });
      requireNative(
        observed.dispatches?.length > 0 &&
          observed.dispatches.every(
            (entry) => entry.outcome === "unknown_after_send" && entry.argsSha256 === setup.argsSha256,
          ),
        "A native tool error alone does not establish an uncertain send.",
      );
      await save("controlled-uncertain-dispatch", observed);
      return finish([
        {
          kind: "uncertain_effect",
          id: `${uncertain.effectId}:uncertain`,
          at: matches[0].at,
          ...uncertain,
          outcome: "unknown_after_send",
        },
      ]);
    },
    async read_reconciliation({ signal }) {
      requireNative(uncertain && uncertainEvidence, "Read the independent uncertain native case first.");
      const observationStartedAt = new Date().toISOString();
      await delay(30_000, undefined, { signal });
      const observed = await supervisor.observeEffectTransport({ runtimeId: runtime.runtimeId, ...uncertain, signal });
      validateNativeRecoveryEffectObservation(observed, { runtimeId: runtime.runtimeId, ...uncertain });
      await save("controlled-reconciliation-observation", {
        observationStartedAt,
        observedAt: new Date().toISOString(),
        observed,
        nativeReconciliation: uncertainEvidence.reconciliation,
      });
      // These pinned public readers do not expose a canonical block. Never
      // upgrade a tool error or model-written 'stopped' message to one.
      return finish([
        {
          kind: "native_reconciliation_unavailable",
          id: `${uncertain.effectId}:reconciliation`,
          at: new Date().toISOString(),
          ...uncertain,
          nativeStatus: uncertainEvidence.reconciliation.status,
          dispatchCount: observed.dispatches.length,
          automaticRetries: observed.automaticRetries,
        },
      ]);
    },
    async review_sources({ signal }) {
      const filename = path.join(session.workspace, "research.json"),
        stat = await lstat(filename);
      requireNative(
        stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.nlink === 1 &&
          stat.size <= 256 * 1024 &&
          (await realpath(filename)) === filename,
        "The research artifact must be an ordinary bounded workspace file.",
      );
      const artifact = JSON.parse(await readFile(filename, "utf8"));
      const review = await supervisor.reviewSources({
        artifact,
        artifactSha256: sha256(artifact),
        tools: current.records,
        signal,
      });
      requireNative(
        review?.reviewerKind === "human" && review.artifactSha256 === sha256(artifact),
        "A human must review this exact native artifact and sources.",
      );
      await save("source-review", review);
      return finish([
        { kind: "source_review", id: `${product}-source-review`, at: new Date().toISOString(), ...review },
      ]);
    },
    async close() {
      if (!closed) {
        closed = true;
        await supervisor.stop();
      }
    },
  };
  try {
    runtime = await supervisor.start({
      taskId,
      revision: profile.revision,
      workspace: session.workspace,
      connectionFile: session.connectionFile,
    });
    requireNative(
      runtime?.revision === profile.revision &&
        path.resolve(runtime.workspace ?? "") === path.resolve(session.workspace) &&
        /^[a-f0-9]{64}$/u.test(runtime.configurationSha256 ?? ""),
      "Native runtime scope/configuration changed.",
    );
    await save("native-runtime", {
      runtimeId: runtime.runtimeId,
      stateId: runtime.stateId,
      revision: runtime.revision,
      configurationSha256: runtime.configurationSha256,
    });
    const review = await supervisor.reviewPermissions({
      taskId,
      configurationSha256: runtime.configurationSha256,
      runtimeId: runtime.runtimeId,
    });
    requireNative(
      review?.configurationSha256 === runtime.configurationSha256 &&
        typeof review.reviewedBy === "string" &&
        review.reviewedBy.length > 0 &&
        Number.isFinite(Date.parse(review.reviewedAt)),
      "The native permission review changed its configuration binding.",
    );
    const policy = normalizeComparisonPermissions(review.policy);
    requireNative(
      policy.files === (product === "hermes" ? "host_user" : "workspace_only") &&
        policy.terminal === "disabled" &&
        policy.skills === "disabled" &&
        policy.schedule === "disabled",
      "Native permission semantics changed.",
    );
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: PERMISSION_REVIEW_VERSION,
        ...session.binding,
        policy,
        reviewedBy: review.reviewedBy,
        reviewedAt: review.reviewedAt,
        sourceReceipts: [...refs],
      }) + "\n",
    );
    const file = await open(path.join(session.evidence, PERMISSION_REVIEW_FILE), "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    refs.push({ path: PERMISSION_REVIEW_FILE, sha256: sha256(bytes) });
    return actions;
  } catch (error) {
    await actions.close();
    throw error;
  }
}
