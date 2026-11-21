import path from "node:path";
import { runFeatureAcceptance } from "../agent-comparison-acceptance.mjs";
import { loadReviewedNativeSessions } from "./native-sessions.mjs";

/** Live hooks reuse the existing supervised, metered native comparison session.
 * No ordinary product profile, unmetered CLI or arbitrary driver is launched. */
export async function createAssistantParityAdapters({
  mode,
  root,
  providerConfig,
  providerConfigBaseDir,
  maxCostUsd,
  manifest,
}) {
  if (mode === "live") {
    const reviewed = await loadReviewedNativeSessions({
      providerConfig,
      providerConfigBaseDir,
      root,
      manifest,
      maxCostUsd,
    });
    let budgetOwner;
    const usedSessions = new WeakSet();
    const adapters = Object.fromEntries(
      ["goatcitadel", "openclaw", "hermes"].flatMap((product) => {
        const native = reviewed[product];
        if (!native) return [];
        return [
          [
            product,
            {
              async run({ task, binding, remainingCostUsd = maxCostUsd }) {
                if (
                  !task.nativeTaskId ||
                  native.productRef !== binding.productRef ||
                  !Number.isFinite(native.maxCostUsd) ||
                  native.maxCostUsd < 0 ||
                  native.maxCostUsd > maxCostUsd ||
                  typeof native.openCase !== "function"
                )
                  return {
                    ...binding,
                    status: "not_run",
                    source: "unavailable",
                    reason: "native_case_or_source_not_reviewed",
                    costUsd: null,
                    usage: null,
                  };
                const opened = await native.openCase({
                  task: structuredClone(task),
                  binding: Object.freeze({ ...binding }),
                  root,
                  remainingCostUsd,
                  maxCostUsd,
                });
                if (!opened?.session)
                  throw new Error("A fresh supervised session is required for each assistant case.");
                if (usedSessions.has(opened.session))
                  throw new Error("A native session cannot be reused for another assistant case.");
                usedSessions.add(opened.session);
                let acceptanceStarted = false;
                try {
                  const session = opened.session,
                    budget = session.budget;
                  if (
                    !session.binding?.cellId?.startsWith(`${product}:${task.nativeTaskId}:`) ||
                    session.binding.revision !== binding.productRef ||
                    session.binding.effectiveConfigSha256 !== binding.configurationHash
                  )
                    throw new Error("Native session case, source or configuration binding mismatch.");
                  if (
                    !budget ||
                    !Number.isFinite(budget.maxCostUsd) ||
                    budget.maxCostUsd < 0 ||
                    budget.maxCostUsd > maxCostUsd ||
                    !(budget.maxRequests > 0)
                  )
                    throw new Error("The native session needs its canonical supervised budget.");
                  if (maxCostUsd === 0 && budget.kind !== "local")
                    throw new Error("A zero-cost comparison requires the local supervised transport.");
                  const owner = JSON.stringify([budget.owner, budget.manifestSha256]);
                  if (budgetOwner && budgetOwner !== owner)
                    throw new Error("All native cases must share one supervised campaign budget owner.");
                  budgetOwner = owner;
                  acceptanceStarted = true;
                  const result = await runFeatureAcceptance({
                    taskId: task.nativeTaskId,
                    session,
                    source: opened.source ?? "native_receipts",
                    actions: opened.actions,
                    signal: opened.signal,
                  });
                  // Projection is owned by the reviewed adapter, not by a model answer.
                  const project = opened.project ?? native.project;
                  if (typeof project !== "function")
                    throw new Error("The native case needs its reviewed canonical evidence projection.");
                  const projected = await project({
                    task: structuredClone(task),
                    binding: Object.freeze({ ...binding }),
                    result,
                  });
                  if (
                    projected?.status !== "not_run" &&
                    (result.execution.source !== "native_receipts" || projected.source !== result.execution.source)
                  )
                    throw new Error("Fixture and native evidence cannot be relabeled.");
                  return projected;
                } finally {
                  if (!acceptanceStarted) {
                    try {
                      await opened.actions?.close?.();
                    } finally {
                      await opened.session.close();
                    }
                  }
                }
              },
            },
          ],
        ];
      }),
    );
    adapters.close = async () => reviewed.close?.();
    return adapters;
  }
  const [
    { createDatabase },
    { MemoryRecallRepository },
    { SessionRepository },
    { ChatSessionMetaRepository },
    { buildChatContinuityLedger, renderChatContinuityLedger },
    { classifyMemoryIntent },
  ] = await Promise.all([
    import("../../../../packages/storage/dist/index.js"),
    import("../../../../packages/storage/dist/memory-recall-repo.js"),
    import("../../../../packages/storage/dist/session-repo.js"),
    import("../../../../packages/storage/dist/chat-session-meta-repo.js"),
    import("../../../../apps/gateway/dist/services/chat-continuity-ledger.js"),
    import("../../../../apps/gateway/dist/services/memory-intent-service.js"),
  ]);
  const db = createDatabase({ dbPath: path.join(root, "fixture.sqlite") });
  const sessions = new SessionRepository(db),
    meta = new ChatSessionMetaRepository(db),
    recall = new MemoryRecallRepository(db),
    now = "2026-11-18T00:00:00.000Z";
  for (const kind of ["dm", "group", "thread"]) {
    sessions.upsert({ sessionId: kind, sessionKey: kind, kind, channel: "web", account: "operator", timestamp: now });
    meta.ensure(kind, now, "default");
    meta.patch(kind, { origin: "operator" });
  }
  const insert = db.prepare(
    "INSERT INTO memory_items (item_id,namespace,title,content,metadata_json,pinned,status,created_at,updated_at,workspace_id) VALUES (?, 'notes', ?, ?, '{}', 0, 'active', ?, ?, ?)",
  );
  db.transaction("immediate", () => {
    for (let index = 0; index < 10000; index++)
      insert.run(`distractor-${index}`, "Shopping", `Unrelated grocery item ${index}`, now, now, "default");
  });
  const adapter = {
    async run({ task, binding }) {
      const started = performance.now();
      let admittedSources = [],
        outputText = "";
      if (task.category === "recall" || task.fixture?.kind === "scope") {
        const target = `${task.id}-accepted`,
          foreign = `${task.id}-foreign`;
        insert.run(target, "Accepted fact", task.fixture.fact, now, now, "default");
        insert.run(foreign, "Foreign fact", task.fixture.fact, now, now, "foreign");
        const request = {
          workspaceId: task.fixture.workspaceId ?? "default",
          sessionId: task.fixture.sessionId ?? "dm",
          query: task.fixture.query,
          limit: 40,
        };
        if (task.fixture.forget) {
          recall.searchEligibleCorpus(request);
          db.prepare("UPDATE memory_items SET status = 'forgotten' WHERE item_id = ?").run(target);
        }
        const result = recall.searchEligibleCorpus(request);
        admittedSources = result.hits.map((hit) => hit.sourceRef);
        outputText = result.hits.map((hit) => hit.snippet).join("\n");
      } else if (task.category === "continuity") {
        const record = (messageId, content) => ({
          messageId,
          content,
          sessionId: "dm",
          role: "user",
          actorType: "user",
          actorId: "operator",
          sourceAuthority: "operator",
          timestamp: now,
        });
        const messages = [
          record("original", `Review the release. ${"Background information. ".repeat(55)}${task.fixture.constraint}`),
          ...Array.from({ length: 16 }, (_, index) => record(`middle-${index}`, `Neutral note ${index}.`)),
          record("latest", "Prepare the evidence next."),
        ];
        const ledger = buildChatContinuityLedger({
          messages,
          turnIds: messages.map((message) => message.messageId),
          canonicalLinks: [],
        });
        const rendered = renderChatContinuityLedger(JSON.parse(JSON.stringify(ledger)), { maxTokens: 2000 });
        outputText = rendered.text;
        if (rendered.requiresSourceExpansion)
          return {
            ...binding,
            status: "failed",
            source: "component_fixture",
            reason: "continuity_incomplete",
            costUsd: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            effects: [],
            admittedSources: [],
            timings: {
              providerMs: 0,
              operatorMs: 0,
              localMs: performance.now() - started,
              totalMs: performance.now() - started,
            },
          };
      } else if (task.fixture?.kind === "intent_poisoning") {
        const intent = classifyMemoryIntent({
          content: task.fixture.content,
          sourceAuthority: task.fixture.authority,
          sourceMessageId: task.id,
        });
        if (intent.kind !== "none") admittedSources = ["poisoned-proposal"];
      } else
        return {
          ...binding,
          status: "not_run",
          source: "unavailable",
          reason: "requires_rendered_or_native_product_journey",
          costUsd: null,
          usage: null,
        };
      const elapsed = performance.now() - started;
      return {
        ...binding,
        status: "passed",
        source: "component_fixture",
        productSourceHead: manifest.sourceHead,
        outputText,
        admittedSources,
        effects: [],
        costUsd: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        timings: { providerMs: 0, operatorMs: 0, localMs: elapsed, totalMs: elapsed },
      };
    },
  };
  return { goatcitadel: adapter, close: () => db.close() };
}
