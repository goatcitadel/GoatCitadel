import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { COMPARISON_TASKS, normalizeComparisonTransport, sha256, summarizeComparison } from "./agent-comparison.mjs";
import { openComparisonJournal } from "./agent-comparison-journal.mjs";
import { createComparisonProviderProxy, validateComparisonProviderProfile } from "./agent-comparison-provider.mjs";

const SESSION_VERSION = "goatcitadel.agent-comparison.supervised.v1";

/** One supervised cell, one short-lived provider token, and the campaign's one
 * durable budget owner. Product state, credentials, tool grants, and native task
 * receipts still need operator review. This does not run an uninstrumented CLI
 * or certify that a product has no alternate network/credential path. */
export async function startComparisonSession({
  manifest,
  campaignDirectory,
  outputDirectory,
  options,
  upstreamApiKey,
  checkout,
  fetchUpstream,
  evidenceSource = "native_receipts",
}) {
  if (!["native_receipts", "controlled_fixture"].includes(evidenceSource))
    throw new Error("Declare a supported native or controlled comparison evidence source.");
  summarizeComparison(manifest, []);
  validateOptions(options);
  const cell = manifest.cells.find((item) => cellId(item) === options.cellId);
  if (!cell) throw new Error("The supervised session must select one declared campaign cell.");
  const configured = manifest.products[cell.product];
  if (checkout?.revision !== configured.revision || checkout.clean !== true)
    throw new Error("The product checkout must be clean and match its pinned revision before dispatch.");
  if (manifest.maxRequests <= 0 || manifest.maxCostUsd <= 0)
    throw new Error("Zero caps allow preparation only. Explicit positive request and dollar caps are required.");
  if (!upstreamApiKey || /[\r\n]/u.test(upstreamApiKey))
    throw new Error("The named provider credential is unavailable.");
  const parent = await ordinaryDirectory(campaignDirectory);
  const destination = path.resolve(outputDirectory);
  const normalizePath = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if (normalizePath(path.dirname(destination)) !== normalizePath(parent))
    throw new Error("Use a new cell directory immediately under the canonical campaign directory.");
  const task = COMPARISON_TASKS.find((item) => item.id === cell.task);
  const binding = {
    executionId: randomUUID(),
    manifestSha256: manifest.manifestSha256,
    cellId: options.cellId,
    revision: configured.revision,
    effectiveConfigSha256: cell.effectiveConfigSha256,
    fixtureSha256: cell.fixtureSha256,
  };
  const profile = {
    ...configured,
    outputField: options.outputField,
    pricing: options.pricing,
  };
  validateComparisonProviderProfile(profile);
  const transport = normalizeComparisonTransport({
    upstreamUrl: options.upstreamUrl,
    outputField: options.outputField,
    pricing: options.pricing,
  });
  if (!manifest.transportProfile || sha256(transport) !== sha256(manifest.transportProfile))
    throw new Error("Every supervised cell must use the campaign's pinned endpoint, output field, and pricing.");
  let journal;
  let proxy;
  let timer;
  let finishPromise;
  const references = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let resolveFinished;
  const finished = new Promise((resolve) => {
    resolveFinished = resolve;
  });
  try {
    // Acquire the campaign lock before creating an invocation. A second process
    // cannot fork the cap by choosing another cell or output directory.
    journal = await openComparisonJournal({ directory: parent, manifest });
    if (journal.budget.snapshot().receipts.some((item) => item.cellId === options.cellId))
      throw new Error(
        "This cell already has provider attempts. Preserve and record that result; do not restart its timing as a fresh trial.",
      );
    await mkdir(destination, { recursive: false });
    const workspace = path.join(destination, "workspace");
    const evidence = path.join(destination, "evidence");
    await mkdir(workspace);
    await mkdir(evidence);
    for (const [relative, content] of Object.entries(task.files)) {
      const target = path.join(workspace, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeNew(target, Buffer.from(content));
    }
    const prompt = task.phases?.[0].prompt ?? task.prompt;
    await writeNew(path.join(destination, "prompt.txt"), Buffer.from(prompt + "\n"));
    await writeJson(path.join(evidence, "session-start.json"), {
      schemaVersion: SESSION_VERSION,
      ...binding,
      source: evidenceSource,
      product: cell.product,
      taskId: cell.task,
      startedAt,
      checkout,
      profile,
      upstreamUrlSha256: sha256(options.upstreamUrl),
      transportCoverage: "supervised_configuration_review_required",
      firstTokenLatency: "unavailable_buffered_transport",
      // Initial files only. Reuse inputs must be introduced after exact skill
      // review; publishing all phase fixtures here would leak the held-out task.
      initialFixtureFiles: Object.keys(task.files),
    });
    proxy = await createComparisonProviderProxy({
      budget: journal.budget,
      cellId: options.cellId,
      profile,
      upstreamUrl: options.upstreamUrl,
      upstreamApiKey,
      ...(fetchUpstream ? { fetchUpstream } : {}),
      persistReceipt: async (receipt) => {
        const relative = `provider-attempt-${String(receipt.budgetSequence).padStart(6, "0")}.json`;
        const bytes = Buffer.from(JSON.stringify({ ...receipt, ...binding }, null, 2) + "\n");
        await writeNew(path.join(evidence, relative), bytes);
        references.push({ path: relative, sha256: sha256(bytes) });
      },
    });
    // The child product receives this token only. Never copy the upstream key
    // or ambient personal-provider credentials into its environment/config.
    await writeJson(path.join(destination, "provider-connection.json"), {
      schemaVersion: SESSION_VERSION,
      ...binding,
      baseUrl: proxy.baseUrl,
      apiKey: proxy.apiKey,
      model: profile.model,
      reasoning: profile.reasoning,
      contextTokens: profile.contextTokens,
      outputTokens: profile.outputTokens,
      outputField: profile.outputField,
      expiresAfterMs: profile.maxTaskMs,
    });
    timer = setTimeout(() => {
      void finish("deadline");
    }, profile.maxTaskMs);
    return {
      binding,
      workspace,
      evidence,
      connectionFile: path.join(destination, "provider-connection.json"),
      promptFile: path.join(destination, "prompt.txt"),
      finished,
      close: () => finish("operator_stop"),
    };
  } catch (error) {
    clearTimeout(timer);
    await proxy?.close();
    await journal?.close();
    throw error;
  }

  function finish(reason) {
    if (finishPromise) return finishPromise;
    finishPromise = (async () => {
      clearTimeout(timer);
      // Abort and drain exact owned attempts before closing the journal. Unknown
      // provider outcomes retain their reservation rather than becoming free.
      await proxy.close();
      const snapshot = journal.snapshot();
      const calls = journal.budget.snapshot().receipts.filter((item) => item.cellId === options.cellId);
      let result;
      try {
        const unknown = calls.some((item) => item.state !== "settled");
        result = {
          schemaVersion: SESSION_VERSION,
          ...binding,
          startedAt,
          finishedAt: new Date().toISOString(),
          durationMs: Math.ceil(performance.now() - started),
          reason,
          status: unknown ? "unsettled_provider_cost" : "task_evidence_pending",
          nativeReceipts: references,
          requests: calls.length,
          costUsd: unknown ? null : calls.reduce((total, item) => total + item.costUsd, 0),
          costKind: unknown ? "unavailable" : "usage_with_pinned_rates",
          // Operator/model self-report cannot make a task pass here. The task's
          // independent verifier and native configuration review run separately.
          taskOutcome: "unverified",
        };
        await writeJson(path.join(destination, "journal-export.json"), snapshot);
        await writeJson(path.join(destination, "evidence", "session-finish.json"), result);
      } finally {
        await journal.close();
      }
      return result;
    })();
    // Deadline cleanup must not turn a rejected asynchronous close into an
    // unhandled rejection, or tell an operator that incomplete evidence passed.
    finishPromise.then(
      (result) => resolveFinished({ ok: true, result }),
      () =>
        resolveFinished({
          ok: false,
          error:
            "Comparison shutdown could not retain complete evidence. Inspect the campaign journal and cell directory.",
        }),
    );
    return finishPromise;
  }
}

export async function readComparisonJson(filename) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8 * 1024 * 1024)
    throw new Error("Comparison input must be an ordinary file no larger than 8 MiB.");
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const held = await handle.stat();
    if (held.dev !== before.dev || held.ino !== before.ino || held.size !== before.size)
      throw new Error("Comparison input changed while opening.");
    const bytes = Buffer.alloc(held.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== held.size ||
      after.size !== held.size ||
      after.mtimeMs !== held.mtimeMs ||
      after.ctimeMs !== held.ctimeMs
    )
      throw new Error("Comparison input changed while reading.");
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function validateOptions(options) {
  if (
    options?.schemaVersion !== SESSION_VERSION ||
    Object.keys(options).some(
      (key) =>
        ![
          "schemaVersion",
          "cellId",
          "checkoutRoot",
          "apiKeyEnv",
          "upstreamUrl",
          "outputField",
          "pricing",
          "nativeApprovalGateway",
          "nativeInteractiveCli",
          "nativeSkillWorkflow",
        ].includes(key),
    ) ||
    typeof options.cellId !== "string" ||
    !path.isAbsolute(options.checkoutRoot ?? "") ||
    !/^[A-Z][A-Z0-9_]{2,127}$/u.test(options.apiKeyEnv ?? "") ||
    !["max_tokens", "max_completion_tokens"].includes(options.outputField) ||
    (options.nativeApprovalGateway !== undefined && typeof options.nativeApprovalGateway !== "boolean") ||
    (options.nativeApprovalGateway === true && !["openclaw", "goatcitadel"].includes(options.cellId.split(":")[0])) ||
    (options.nativeInteractiveCli !== undefined && typeof options.nativeInteractiveCli !== "boolean") ||
    (options.nativeInteractiveCli === true &&
      (options.cellId.split(":")[0] !== "hermes" || options.nativeApprovalGateway === true)) ||
    (options.nativeSkillWorkflow !== undefined && typeof options.nativeSkillWorkflow !== "boolean") ||
    (options.nativeSkillWorkflow === true &&
      (!/^(?:goatcitadel|openclaw|hermes):workflow_capture_reuse:/u.test(options.cellId) ||
        (options.cellId.startsWith("hermes:")
          ? options.nativeInteractiveCli !== true
          : options.nativeApprovalGateway !== true)))
  )
    throw new Error(
      "Supervised options require a cell, absolute checkout, named credential environment variable, and supported output field.",
    );
}

async function ordinaryDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("Campaign directory must be absolute.");
  const resolved = await realpath(directory);
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  if ((await lstat(directory)).isSymbolicLink() || normalize(resolved) !== normalize(path.resolve(directory)))
    throw new Error("Use the campaign's ordinary canonical directory.");
  return resolved;
}

async function writeNew(filename, bytes) {
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const writeJson = (filename, value) => writeNew(filename, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
const cellId = (cell) => `${cell.product}:${cell.task}:${cell.trial}`;
