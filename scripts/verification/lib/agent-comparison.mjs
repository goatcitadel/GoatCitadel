import { createHash } from "node:crypto";
import path from "node:path";
import { normalizePermissionEvidence } from "./agent-comparison-permissions.mjs";
import { FEATURE_ACCEPTANCE_SUITE, FEATURE_ACCEPTANCE_TASKS } from "./agent-comparison-acceptance-fixtures.mjs";

export const COMPARISON_VERSION = "goatcitadel.agent-comparison.v1";
export const PRODUCTS = Object.freeze(["goatcitadel", "openclaw", "hermes"]);
export const COMPARISON_TASKS = Object.freeze([
  {
    id: "cited_research",
    prompt:
      "Using only sources/atlas.md and sources/beacon.md, compare the plans and recommend the cheaper plan for 80 GB. Create answer.json with plans (one entry per tier: name, monthlyPriceUsd, includedGb, source filename) and recommendation (name, requiredGb, source filename). Include all three tiers and cite the source for every factual entry. Explain the recommendation briefly.",
    files: {
      "sources/atlas.md": "Atlas costs $12 per month and includes 100 GB of storage.\n",
      "sources/beacon.md":
        "Beacon costs $9 per month and includes 50 GB of storage; its 100 GB plan costs $15 per month.\n",
    },
    criteria: ["correct_prices", "correct_storage", "atlas_recommended_for_80gb", "claims_cited"],
  },
  {
    id: "code_repair",
    prompt:
      "Fix src/total.mjs so totalCents sums integer unit prices times quantity. Reject negative or non-integer values. Add focused tests covering empty input, multiple items, and invalid values. Run the tests and report the result.",
    files: {
      "src/total.mjs":
        "export function totalCents(items) { return items.reduce((sum, item) => sum + item.unitCents, 0); }\n",
    },
    criteria: ["correct_totals", "invalid_input_rejected", "focused_tests_pass", "unrelated_files_preserved"],
  },
  {
    id: "document_generation",
    prompt:
      "Create report.md from input/launch.json. Include an executive summary, an owner-and-date checklist, risks, and a recommendation. Preserve all dates and quantities and identify the missing rollback owner.",
    files: {
      "input/launch.json": JSON.stringify({
        release: "Harbor",
        date: "2030-03-14",
        pilotUsers: 25,
        tasks: [
          { owner: "Ari", action: "Verify backup", date: "2030-03-10" },
          { owner: null, action: "Own rollback", date: "2030-03-12" },
        ],
      }),
    },
    criteria: ["facts_preserved", "actionable_checklist", "missing_owner_identified", "artifact_created"],
  },
  {
    id: "workflow_capture_reuse",
    prompt:
      "Complete the source workflow, capture it as a reviewed reusable skill, then use that exact skill in a new session. Follow the declared phases in order; no skill is preinstalled for this scenario.",
    files: {
      "input/source-changes.json": JSON.stringify({
        fixed: ["Missing attachment name"],
        evidence: ["attachment-name regression test passed"],
        unverified: ["every attachment format works"],
      }),
    },
    phases: [
      {
        id: "source_workflow",
        newSession: true,
        prompt:
          "Create source-release.md from input/source-changes.json with What changed, Evidence, and Unverified sections. Keep unsupported claims only in Unverified. Check the finished document against the input.",
      },
      {
        id: "capture_review",
        newSession: false,
        prompt:
          "Save this verified release-note workflow as a reusable skill named release-note. Include inputs, steps, failure handling, output format, and verification. Present the exact skill for operator review before making it available. Retain its source-turn reference and instruction hash.",
        operatorAction:
          "Review the generated instructions and activate only this exact version through the product's supported owner.",
      },
      {
        id: "reuse",
        newSession: true,
        prompt:
          "Use the reviewed release-note skill to create release.md from input/changes.json. Identify unverified claims and record the exact skill actually loaded. Do not activate another skill.",
        files: {
          "input/changes.json": JSON.stringify({
            fixed: ["Duplicate reminder after reconnect"],
            evidence: ["reconnect regression test passed"],
            unverified: ["all providers are faster"],
          }),
        },
      },
    ],
    criteria: [
      "source_workflow_verified",
      "skill_captured_from_source",
      "reviewed_skill_loaded_in_new_session",
      "output_contract_followed",
      "unverified_claim_separated",
      "no_unrequested_activation",
    ],
  },
  {
    id: "scheduled_delivery",
    prompt:
      "Schedule one reminder for the supplied test time and authorized test destination containing the exact phrase HARBOR PILOT CHECK. Wait for the provider delivery receipt. Reconnect and confirm the reminder is not delivered twice.",
    files: {},
    criteria: ["schedule_persisted", "authorized_destination", "provider_receipt", "no_duplicate_after_reconnect"],
  },
]);
export const SEPARATE_TASKS = Object.freeze(["approval_resume", "restart_recovery", "native_windows_remote_worker"]);
export function comparisonTasks(manifest = {}) {
  if (manifest.suite === undefined) return COMPARISON_TASKS;
  if (manifest.suite === FEATURE_ACCEPTANCE_SUITE) return FEATURE_ACCEPTANCE_TASKS;
  throw new Error("Unsupported opt-in comparison suite.");
}
export const sha256 = (value) =>
  createHash("sha256")
    .update(typeof value === "string" || value instanceof Uint8Array ? value : canonical(value))
    .digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function finite(value, minimum = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

/** Public, credential-free transport and accounting identity shared by every cell. */
export function normalizeComparisonTransport(value) {
  const local = value?.kind === "local";
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).every((key) =>
        (local
          ? ["kind", "upstreamUrl", "outputField", "localRuntime"]
          : ["upstreamUrl", "outputField", "pricing"]
        ).includes(key),
      ),
    "Comparison transport contains unsupported fields.",
  );
  let upstream;
  try {
    upstream = new URL(value.upstreamUrl);
  } catch {
    throw new Error("Comparison upstream must be a fixed supported chat-completions endpoint.");
  }
  requireValue(
    (local
      ? upstream.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(upstream.hostname) &&
        /^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?\//u.test(value.upstreamUrl)
      : upstream.protocol === "https:") &&
      !upstream.username &&
      !upstream.password &&
      !upstream.search &&
      !upstream.hash &&
      upstream.pathname.endsWith("/chat/completions"),
    "Comparison upstream requires HTTPS, or literal loopback HTTP in declared local mode.",
  );
  requireValue(
    ["max_tokens", "max_completion_tokens"].includes(value.outputField),
    "Comparison output field is unsupported.",
  );
  if (local) {
    const runtime = value.localRuntime;
    requireValue(
      runtime &&
        typeof runtime === "object" &&
        !Array.isArray(runtime) &&
        Object.keys(runtime).length === 4 &&
        ["runtime", "modelSha256", "quantization", "hardware"].every(
          (key) => typeof runtime[key] === "string" && runtime[key].trim() && runtime[key].length <= 256,
        ) &&
        /^[a-f0-9]{64}$/u.test(runtime.modelSha256),
      "Local comparison requires bounded runtime, model hash, quantization and hardware metadata.",
    );
    return { kind: "local", upstreamUrl: upstream.href, outputField: value.outputField, localRuntime: { ...runtime } };
  }
  const pricing = value.pricing;
  requireValue(
    pricing &&
      typeof pricing === "object" &&
      !Array.isArray(pricing) &&
      Object.keys(pricing).every((key) =>
        ["inputUsdPerMillion", "outputUsdPerMillion", "requestUsd", "observedAt", "sourceSha256"].includes(key),
      ) &&
      /^[a-f0-9]{64}$/u.test(pricing.sourceSha256 ?? "") &&
      Number.isFinite(Date.parse(pricing.observedAt)) &&
      [pricing.inputUsdPerMillion, pricing.outputUsdPerMillion, pricing.requestUsd].every((amount) => finite(amount)) &&
      pricing.inputUsdPerMillion + pricing.outputUsdPerMillion + pricing.requestUsd > 0,
    "Comparison provider requires pinned positive worst-case text-token pricing without extra fields.",
  );
  return { upstreamUrl: upstream.href, outputField: value.outputField, pricing: { ...pricing } };
}

export function normalizeComparisonPilotBudget(value) {
  requireValue(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 4 &&
      /^[a-f0-9-]{36}$/u.test(value.pilotId ?? "") &&
      typeof value.directory === "string" &&
      path.isAbsolute(value.directory) &&
      Number.isSafeInteger(value.maxRequests) &&
      value.maxRequests > 0 &&
      value.maxRequests <= 450 &&
      finite(value.maxCostUsd, Number.EPSILON) &&
      value.maxCostUsd <= 25,
    "Hosted pilot requires an absolute shared journal directory and caps at most 450 requests and $25.",
  );
  return {
    pilotId: value.pilotId,
    directory: path.resolve(value.directory),
    maxRequests: value.maxRequests,
    maxCostUsd: value.maxCostUsd,
  };
}

export function normalizeComparisonLocalPilotBudget(value) {
  requireValue(value?.maxCostUsd === 0, "Local pilot accounting requires zero provider dollars.");
  const normalized = normalizeComparisonPilotBudget({ ...value, maxCostUsd: Number.EPSILON });
  return { ...normalized, maxCostUsd: 0 };
}

export function prepareComparison(config) {
  const tasks = comparisonTasks(config);
  requireValue(config?.schemaVersion === COMPARISON_VERSION, "Comparison schema is unsupported.");
  requireValue(
    Number.isInteger(config.trials) && config.trials >= 3 && config.trials <= 20,
    "Declare between 3 and 20 trials.",
  );
  const transportProfile =
    config.transportProfile === undefined ? undefined : normalizeComparisonTransport(config.transportProfile);
  const pilotBudget = config.pilotBudget === undefined ? undefined : normalizeComparisonPilotBudget(config.pilotBudget);
  const localPilotBudget = config.localPilotBudget === undefined ? undefined : normalizeComparisonLocalPilotBudget(config.localPilotBudget);
  requireValue(!localPilotBudget || (transportProfile?.kind === "local" && !pilotBudget && config.maxRequests <= localPilotBudget.maxRequests),
    "Local pilot accounting requires the local transport and its independent aggregate cap.");
  requireValue(
    transportProfile?.kind !== "local" || (config.maxCostUsd === 0 && !pilotBudget),
    "Local comparison has zero provider dollars and cannot consume a hosted pilot budget.",
  );
  requireValue(
    !pilotBudget || (config.maxRequests <= pilotBudget.maxRequests && config.maxCostUsd <= pilotBudget.maxCostUsd),
    "Campaign caps exceed the shared hosted pilot.",
  );
  requireValue(
    Number.isInteger(config.maxRequests) && config.maxRequests >= 0 && finite(config.maxCostUsd),
    "Explicit request and dollar caps are required; zero prepares only.",
  );
  requireValue(
    config.products && Object.keys(config.products).length === PRODUCTS.length,
    "Declare exactly GoatCitadel, OpenClaw, and Hermes.",
  );
  const products = {};
  for (const product of PRODUCTS) {
    const value = config.products[product];
    requireValue(value && /^[a-f0-9]{40}$/.test(value.revision), `${product} requires its exact source revision.`);
    requireValue(
      Object.keys(value).every((key) =>
        [
          "revision",
          "provider",
          "model",
          "tools",
          "grants",
          "reasoning",
          "contextTokens",
          "outputTokens",
          "maxTaskMs",
        ].includes(key),
      ),
      `${product} configuration contains unsupported fields; credentials do not belong in the manifest.`,
    );
    requireValue(
      typeof value.provider === "string" && value.provider && typeof value.model === "string" && value.model,
      `${product} requires its effective provider and model.`,
    );
    requireValue(
      Array.isArray(value.tools) &&
        value.tools.every((tool) => typeof tool === "string" && tool.trim()) &&
        Array.isArray(value.grants) &&
        value.grants.every((grant) => typeof grant === "string" && grant.trim()),
      `${product} requires explicit tools and grants.`,
    );
    requireValue(
      typeof value.reasoning === "string" &&
        value.reasoning.trim() &&
        [value.contextTokens, value.outputTokens, value.maxTaskMs].every(
          (limit) => Number.isSafeInteger(limit) && limit > 0,
        ),
      `${product} requires reasoning, context, output, and wall-time limits.`,
    );
    products[product] = {
      ...value,
      tools: [...new Set(value.tools)].sort(),
      grants: [...new Set(value.grants)].sort(),
    };
  }
  const equivalence = (value) =>
    sha256({
      provider: value.provider,
      model: value.model,
      tools: value.tools,
      grants: value.grants,
      reasoning: value.reasoning,
      contextTokens: value.contextTokens,
      outputTokens: value.outputTokens,
      maxTaskMs: value.maxTaskMs,
    });
  const comparable = new Set(PRODUCTS.map((product) => equivalence(products[product]))).size === 1;
  const cells = tasks.flatMap((task, taskIndex) =>
    Array.from({ length: config.trials }, (_, trial) => {
      // Rotate product order by task and repetition to reduce warm-cache/order bias.
      return PRODUCTS.map((_, offset) => PRODUCTS[(offset + trial + taskIndex) % PRODUCTS.length]).map((product) => ({
        product,
        task: task.id,
        trial: trial + 1,
        fixtureSha256: sha256(task),
        effectiveConfigSha256: equivalence(products[product]),
        status: "not_run",
      }));
    }).flat(),
  );
  const manifest = {
    schemaVersion: COMPARISON_VERSION,
    fixtureSetSha256: sha256(tasks),
    ...(config.suite === undefined ? {} : { suite: config.suite }),
    trials: config.trials,
    maxRequests: config.maxRequests,
    maxCostUsd: config.maxCostUsd,
    ...(transportProfile === undefined ? {} : { transportProfile }),
    ...(pilotBudget === undefined ? {} : { pilotBudget }),
    ...(localPilotBudget === undefined ? {} : { localPilotBudget }),
    products,
    comparable,
    cells,
    separateTasks: SEPARATE_TASKS.map((task) => ({
      task,
      support: Object.fromEntries(PRODUCTS.map((product) => [product, "unknown"])),
    })),
  };
  return { ...manifest, manifestSha256: sha256(manifest) };
}

/** Reserve before EVERY transport attempt, including retry/child calls. Unknown outcomes retain the full reserve. */
export class ComparisonDispatchBudget {
  #requests = 0;
  #reservedUsd = 0;
  #receipts = [];
  #persist;
  #persistenceTail = Promise.resolve();
  constructor({ maxRequests, maxCostUsd, persist, events = [], allowZeroCost = false }) {
    requireValue(
      Number.isInteger(maxRequests) && maxRequests >= 0 && finite(maxCostUsd) && typeof persist === "function",
      "A durable budget sink and explicit caps are required.",
    );
    this.maxRequests = maxRequests;
    this.maxCostUsd = maxCostUsd;
    requireValue(
      typeof allowZeroCost === "boolean" && (!allowZeroCost || maxCostUsd === 0),
      "Zero-cost accounting requires an explicit local zero-dollar budget.",
    );
    this.allowZeroCost = allowZeroCost;
    this.#persist = persist;
    requireValue(Array.isArray(events), "Budget recovery requires the complete ordered durable journal.");
    for (const event of events) {
      requireValue(
        Number.isSafeInteger(event.sequence) &&
          event.sequence > 0 &&
          typeof event.cellId === "string" &&
          event.cellId &&
          ["primary", "retry", "child", "unclassified"].includes(event.role) &&
          finite(event.maximumCostUsd, this.allowZeroCost ? 0 : Number.EPSILON),
        "Invalid durable budget entry.",
      );
      const previous = this.#receipts[event.sequence - 1];
      if (!previous) {
        requireValue(
          event.sequence === this.#requests + 1 && event.state === "reserved" && event.costUsd === null,
          "Budget journal is incomplete or reordered.",
        );
        requireValue(
          this.#requests < maxRequests && this.#reservedUsd + event.maximumCostUsd <= maxCostUsd + 1e-12,
          "Recovered reservations exceed the declared caps.",
        );
        this.#requests++;
        this.#reservedUsd += event.maximumCostUsd;
        this.#receipts.push(structuredClone(event));
      } else {
        requireValue(
          previous.cellId === event.cellId &&
            previous.role === event.role &&
            previous.maximumCostUsd === event.maximumCostUsd &&
            previous.state === "reserved",
          "Budget settlement changed its reservation or replayed a terminal event.",
        );
        requireValue(
          (event.state === "settled" && finite(event.costUsd) && event.costUsd <= event.maximumCostUsd) ||
            (event.state === "unknown" && event.costUsd === null),
          "Invalid durable budget settlement.",
        );
        if (event.state === "settled") this.#reservedUsd -= event.maximumCostUsd - event.costUsd;
        this.#receipts[event.sequence - 1] = structuredClone(event);
      }
    }
  }
  async dispatch({ cellId, role, maximumCostUsd }, transport) {
    requireValue(
      typeof cellId === "string" &&
        cellId &&
        ["primary", "retry", "child", "unclassified"].includes(role) &&
        finite(maximumCostUsd, this.allowZeroCost ? 0 : Number.EPSILON),
      "Dispatch needs cell, role, and a positive worst-case cost unless local zero-cost accounting is explicit.",
    );
    requireValue(
      this.#requests < this.maxRequests && this.#reservedUsd + maximumCostUsd <= this.maxCostUsd + 1e-12,
      "Comparison budget exhausted before dispatch.",
    );
    const receipt = { sequence: ++this.#requests, cellId, role, maximumCostUsd, state: "reserved", costUsd: null };
    this.#reservedUsd += maximumCostUsd;
    this.#receipts.push(receipt);
    // Synchronous reservations precede awaiting the sink, so concurrent children cannot oversubscribe.
    await this.#write(receipt);
    try {
      const result = await transport(Object.freeze({ ...receipt }));
      requireValue(
        result && finite(result.costUsd) && result.costUsd <= maximumCostUsd,
        "Transport returned missing or over-reservation canonical cost.",
      );
      receipt.state = "settled";
      receipt.costUsd = result.costUsd;
      // Persist settlement before making unused capacity available to another attempt.
      await this.#write(receipt);
      this.#reservedUsd -= maximumCostUsd - result.costUsd;
      return result;
    } catch (error) {
      receipt.state = "unknown";
      receipt.costUsd = null;
      await this.#write(receipt);
      throw error;
    }
  }
  snapshot() {
    return {
      requests: this.#requests,
      committedOrReservedUsd: this.#reservedUsd,
      receipts: structuredClone(this.#receipts),
    };
  }

  #write(receipt) {
    const snapshot = structuredClone(receipt);
    this.#persistenceTail = this.#persistenceTail.then(() => this.#persist(snapshot));
    return this.#persistenceTail;
  }
}

/** Evaluation receipts are produced by independent task verifiers, never by model self-grading. */
export function summarizeComparison(manifest, receipts) {
  const { manifestSha256, ...material } = manifest;
  const expected = prepareComparison(material);
  requireValue(
    sha256(material) === manifestSha256 && expected.manifestSha256 === manifestSha256,
    "Comparison manifest or fixtures changed.",
  );
  requireValue(
    Array.isArray(receipts) && receipts.length <= manifest.cells.length,
    "Unexpected comparison receipt count.",
  );
  const seen = new Set();
  const cells = manifest.cells.map((cell) => ({
    ...cell,
    outcome: "not_run",
    durationMs: null,
    costUsd: null,
    requests: null,
    manualInterventions: null,
    timeToUsefulOutputMs: null,
    inputTokens: null,
    outputTokens: null,
    repeatedCorrections: null,
    permissionEvidence: null,
  }));
  for (const receipt of receipts) {
    const key = `${receipt.product}:${receipt.task}:${receipt.trial}`;
    const cell = cells.find((candidate) => `${candidate.product}:${candidate.task}:${candidate.trial}` === key);
    requireValue(cell && !seen.has(key), "Unknown or duplicate comparison cell.");
    seen.add(key);
    requireValue(
      receipt.manifestSha256 === manifestSha256 &&
        receipt.fixtureSha256 === cell.fixtureSha256 &&
        receipt.effectiveConfigSha256 === cell.effectiveConfigSha256 &&
        receipt.revision === manifest.products[receipt.product].revision,
      "Receipt does not match pinned inputs and effective configuration.",
    );
    requireValue(
      ["live", "controlled"].includes(receipt.evidenceKind),
      "Receipt must declare live or controlled evidence.",
    );
    requireValue(["passed", "failed", "blocked", "unsupported"].includes(receipt.outcome), "Unknown task outcome.");
    requireValue(
      finite(receipt.durationMs) &&
        (receipt.costUsd === null || finite(receipt.costUsd)) &&
        Number.isInteger(receipt.requests) &&
        receipt.requests >= 0 &&
        Number.isInteger(receipt.manualInterventions) &&
        receipt.manualInterventions >= 0,
      "Invalid task telemetry; missing cost must be null.",
    );
    const telemetry = {};
    for (const name of ["timeToUsefulOutputMs", "inputTokens", "outputTokens", "repeatedCorrections"]) {
      const value = receipt[name] ?? null;
      requireValue(
        value === null ||
          (finite(value) &&
            (name === "timeToUsefulOutputMs" ? value <= receipt.durationMs : Number.isSafeInteger(value))),
        `Invalid ${name}; unavailable measurements must be null.`,
      );
      telemetry[name] = value;
    }
    requireValue(
      telemetry.repeatedCorrections === null || telemetry.repeatedCorrections <= receipt.manualInterventions,
      "Repeated corrections cannot exceed manual interventions.",
    );
    const task = comparisonTasks(manifest).find((value) => value.id === receipt.task);
    if (receipt.outcome === "passed") {
      requireValue(
        receipt.requests > 0 && receipt.costUsd !== null,
        "Passing evidence needs observed provider calls and cost.",
      );
      requireValue(
        task.criteria.every(
          (criterion) =>
            receipt.checks?.[criterion]?.passed === true &&
            /^[a-f0-9]{64}$/.test(receipt.checks[criterion].evidenceSha256),
        ),
        "A passed task requires every independent criterion and evidence hash.",
      );
      requireValue(
        typeof receipt.verifier === "string" &&
          receipt.verifier !== "model_self_grade" &&
          /^[a-f0-9]{64}$/.test(receipt.verifierSha256),
        "Record an independent verifier and its source hash.",
      );
    }
    const permissionEvidence = normalizePermissionEvidence(receipt.permissionEvidence);
    let pilotAccounting;
    const sharedPolicy = manifest.pilotBudget ?? manifest.localPilotBudget;
    if (sharedPolicy) {
      const value = receipt.pilotAccounting;
      requireValue(
        value &&
          value.pilotId === sharedPolicy.pilotId &&
          value.pilotBudgetSha256 === sha256(sharedPolicy) &&
          /^[a-f0-9]{64}$/u.test(value.journalSha256 ?? "") &&
          Number.isSafeInteger(value.requests) &&
          value.requests >= receipt.requests &&
          value.requests <= sharedPolicy.maxRequests &&
          finite(value.committedOrReservedUsd) &&
          value.committedOrReservedUsd <= sharedPolicy.maxCostUsd + 1e-12 &&
          Number.isSafeInteger(value.unsettledRequests) &&
          value.unsettledRequests >= 0 &&
          value.unsettledRequests <= value.requests,
        "Pilot receipts require verified shared accounting within the aggregate caps.",
      );
      pilotAccounting = Object.fromEntries(
        [
          "pilotId",
          "pilotBudgetSha256",
          "journalSha256",
          "requests",
          "committedOrReservedUsd",
          "unsettledRequests",
        ].map((key) => [key, value[key]]),
      );
    }
    if (permissionEvidence)
      requireValue(
        Object.entries(permissionEvidence.policy).every(([tool, policy]) =>
          manifest.products[receipt.product].tools.includes(tool) ? policy !== "disabled" : policy === "disabled",
        ),
        "Reviewed permission policy conflicts with the declared tools.",
      );
    Object.assign(cell, {
      evidenceKind: receipt.evidenceKind,
      outcome: receipt.outcome,
      status: receipt.outcome,
      durationMs: receipt.durationMs,
      requests: receipt.requests,
      costUsd: receipt.costUsd,
      manualInterventions: receipt.manualInterventions,
      permissionEvidence,
      ...(pilotAccounting ? { pilotAccounting } : {}),
      ...telemetry,
      ...(receipt.outcome === "passed"
        ? {
            verifier: receipt.verifier,
            verifierSha256: receipt.verifierSha256,
            checks: Object.fromEntries(
              task.criteria.map((criterion) => [
                criterion,
                {
                  passed: true,
                  evidenceSha256: receipt.checks[criterion].evidenceSha256,
                },
              ]),
            ),
          }
        : {}),
    });
  }
  const requests = cells.reduce((sum, cell) => sum + (cell.requests ?? 0), 0);
  const knownCostUsd = cells.reduce((sum, cell) => sum + (cell.costUsd ?? 0), 0);
  const complete = cells.every(
    (cell) => ["passed", "failed"].includes(cell.outcome) && cell.evidenceKind === "live" && cell.costUsd !== null,
  );
  const withinBudget = requests <= manifest.maxRequests && knownCostUsd <= manifest.maxCostUsd + 1e-12;
  const permissionsReviewed = cells.every(
    (cell) =>
      cell.permissionEvidence &&
      Object.values(cell.permissionEvidence.policy).every((value) => value !== "unknown") &&
      manifest.products[cell.product].tools.every((tool) => Object.hasOwn(cell.permissionEvidence.policy, tool)),
  );
  const policyHashes = new Set(
    cells.filter((cell) => cell.permissionEvidence).map((cell) => sha256(cell.permissionEvidence.policy)),
  );
  const permissionEquivalence =
    policyHashes.size > 1 ? "different" : permissionsReviewed ? "reviewed_equivalent" : "missing_or_unknown";
  const comparable = manifest.comparable && permissionEquivalence === "reviewed_equivalent";
  return {
    schemaVersion: COMPARISON_VERSION,
    manifestSha256,
    status: complete && comparable && withinBudget ? "comparable_live_results" : "incomplete_or_not_comparable",
    comparable,
    declaredConfigurationComparable: manifest.comparable,
    permissionEquivalence,
    withinBudget,
    requests,
    knownCostUsd,
    transportKind: manifest.transportProfile?.kind === "local" ? "local" : "hosted",
    ...(manifest.transportProfile?.kind === "local" ? { localRuntime: manifest.transportProfile.localRuntime } : {}),
    ...(manifest.pilotBudget ? { pilotBudget: manifest.pilotBudget } : {}),
    ...(manifest.localPilotBudget ? { localPilotBudget: manifest.localPilotBudget } : {}),
    unknownCostCells: cells.filter((cell) => cell.costUsd === null).length,
    outcomes: PRODUCTS.flatMap((product) =>
      comparisonTasks(manifest).map((task) =>
        summarizeOutcomes(
          product,
          task.id,
          cells.filter((cell) => cell.product === product && cell.task === task.id),
        ),
      ),
    ),
    cells,
    separateTasks: manifest.separateTasks,
  };
}

function summarizeOutcomes(product, task, cells) {
  const observed = cells.filter((cell) => cell.evidenceKind === "live" && ["passed", "failed"].includes(cell.outcome));
  const passed = observed.filter((cell) => cell.outcome === "passed").length;
  return {
    product,
    task,
    trials: cells.length,
    observed: observed.length,
    excluded: cells.length - observed.length,
    passed,
    failed: observed.length - passed,
    successRate: observed.length ? passed / observed.length : null,
    durationMs: distribution(observed.map((cell) => cell.durationMs)),
    costUsd: observed.every((cell) => cell.costUsd !== null)
      ? distribution(observed.map((cell) => cell.costUsd))
      : null,
    manualInterventions: distribution(observed.map((cell) => cell.manualInterventions)),
    ...Object.fromEntries(
      ["timeToUsefulOutputMs", "inputTokens", "outputTokens", "repeatedCorrections"].map((name) => [
        name,
        observed.every((cell) => cell[name] !== null) ? distribution(observed.map((cell) => cell[name])) : null,
      ]),
    ),
  };
}

function distribution(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    max: sorted.at(-1),
  };
}

export function comparisonMarkdown(report) {
  return [
    `# Agent task comparison`,
    ``,
    `Status: ${report.status}`,
    `Configured permission equivalence: ${report.permissionEquivalence}. Matching tool names alone do not establish equivalent permissions.`,
    ``,
    `Pinned manifest: ${report.manifestSha256}`,
    ``,
    `Requests observed: ${report.requests}. Known cost: $${report.knownCostUsd.toFixed(4)}. Cells without cost: ${report.unknownCostCells}.`,
    report.transportKind === "local"
      ? "Local inference: USD measures provider charges only (zero); hardware, electricity and operator time are not priced. Missing or unbounded usage remains unknown."
      : "Hosted inference: USD uses canonical usage and the pinned provider rates.",
    ...(report.pilotBudget
      ? [
          `Shared hosted pilot: ${report.pilotBudget.pilotId}; all baseline, retry, child and retest campaigns share its retained journal and cap.`,
        ]
      : []),
    ...(report.localPilotBudget
      ? [`Shared local pilot: ${report.localPilotBudget.pilotId}; baseline, retry, child and retest campaigns share the conservative ${report.localPilotBudget.maxRequests}-request policy. Provider dollars remain zero.`]
      : []),
    ``,
    "Controlled, unsupported, blocked, and unrun cells do not count as live task success.",
    "",
    "| Product | Reviewed permission policies |",
    "|---|---|",
    ...PRODUCTS.map((product) => {
      const policies = [
        ...new Set(
          report.cells
            .filter((cell) => cell.product === product)
            .map((cell) =>
              cell.permissionEvidence
                ? Object.entries(cell.permissionEvidence.policy)
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(", ")
                : "unreviewed",
            ),
        ),
      ];
      return `| ${product} | ${policies.join("; ")} |`;
    }),
    "",
    "| Product | Task | Live passed / observed | Excluded | Median ms | Median USD | Median interventions |",
    "|---|---|---:|---:|---:|---:|---:|",
    ...report.outcomes.map(
      (row) =>
        `| ${row.product} | ${row.task} | ${row.passed} / ${row.observed} | ${row.excluded} | ${row.durationMs?.median ?? "unknown"} | ${row.costUsd?.median ?? "unknown"} | ${row.manualInterventions?.median ?? "unknown"} |`,
    ),
    "",
    "Medians summarize observed live outcomes only. Excluded trials and incomplete costs prevent a complete comparison.",
    "",
    "| Product | Task | Median useful-output ms | Median input tokens | Median output tokens | Median repeated corrections |",
    "|---|---|---:|---:|---:|---:|",
    ...report.outcomes.map(
      (row) =>
        `| ${row.product} | ${row.task} | ${row.timeToUsefulOutputMs?.median ?? "unknown"} | ${row.inputTokens?.median ?? "unknown"} | ${row.outputTokens?.median ?? "unknown"} | ${row.repeatedCorrections?.median ?? "unknown"} |`,
    ),
    "",
    "Useful output is the first independently verified task result; a typing indicator or first token does not qualify. Missing measurements stay unknown.",
    "",
    "| Product | Task | Trial | Outcome | Evidence | Duration ms | Cost USD |",
    "|---|---|---:|---|---|---:|---:|",
    ...report.cells.map(
      (cell) =>
        `| ${cell.product} | ${cell.task} | ${cell.trial} | ${cell.outcome} | ${cell.evidenceKind ?? "none"} | ${cell.durationMs ?? "unknown"} | ${cell.costUsd ?? "unknown"} |`,
    ),
    "",
    "Restart recovery, approval resume, and native remote execution are reported separately; unknown support is not a failure.",
    "",
  ].join("\n");
}
