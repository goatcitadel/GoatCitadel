import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256, PRODUCTS } from "../agent-comparison.mjs";
import { scoreAssistantCase, compareAssistantProducts } from "./scoring.mjs";
import { createAssistantParityAdapters } from "./adapters.mjs";
import { collectAssistantSourceFingerprint } from "./source-fingerprint.mjs";

export function separateStageTimings(input) {
  const keys = ["providerMs", "operatorMs", "localMs", "totalMs"];
  if (
    !input ||
    keys.some((key) => !Number.isFinite(input[key]) || input[key] < 0) ||
    input.providerMs + input.operatorMs + input.localMs > input.totalMs + 1
  )
    throw new Error("Timings must separate measured provider, operator and local work.");
  return Object.fromEntries(keys.map((key) => [key, input[key]]));
}
export function validateAssistantParityReceipt(receipt, binding, { maxCostUsd } = {}) {
  for (const key of ["mode", "product", "productRef", "configurationHash", "model", "split", "caseId"])
    if (!binding[key] || receipt?.[key] !== binding[key]) throw new Error(`Assistant receipt binding mismatch: ${key}`);
  if (!["passed", "failed", "not_run"].includes(receipt.status)) throw new Error("Unknown result disposition.");
  if (binding.mode === "live" && !(Number.isFinite(maxCostUsd) && maxCostUsd >= 0))
    throw new Error("Live comparison requires a finite cost ceiling.");
  if (
    receipt.status !== "not_run" &&
    receipt.source !== (binding.mode === "fixture" ? "component_fixture" : "native_receipts")
  )
    throw new Error("Fixture and native evidence cannot be relabeled.");
  if (receipt.status !== "not_run") {
    separateStageTimings(receipt.timings);
    if (
      binding.mode === "live" &&
      (!binding.independentTaskId || receipt.independentTaskId !== binding.independentTaskId)
    )
      throw new Error("Native evidence needs its frozen independent task identity.");
  }
  if (receipt.costUsd !== null && (!Number.isFinite(receipt.costUsd) || receipt.costUsd < 0))
    throw new Error("Unknown cost must remain null.");
  return receipt;
}
export async function runAssistantParitySuite({
  mode = "fixture",
  products = PRODUCTS,
  caseIds,
  split = "development",
  outputRoot,
  providerConfig = {},
  providerConfigBaseDir,
  maxCostUsd,
} = {}) {
  if (
    !["fixture", "live"].includes(mode) ||
    !["development", "held_out", "adversarial"].includes(split) ||
    !products.length ||
    products.some((product) => !PRODUCTS.includes(product))
  )
    throw new Error("Select a bounded comparison mode, product and split.");
  if (mode === "live" && !(Number.isFinite(maxCostUsd) && maxCostUsd >= 0))
    throw new Error("Live comparison requires a finite cost ceiling.");
  const fixtureRoot = new URL("../../fixtures/assistant-parity/", import.meta.url);
  const corpus = JSON.parse(await fs.readFile(new URL("cases.json", fixtureRoot), "utf8"));
  const frozen = JSON.parse(await fs.readFile(new URL("manifest.json", fixtureRoot), "utf8"));
  if (sha256(corpus) !== frozen.corpusSha256)
    throw new Error("Frozen fixture corpus changed; review labels and version before running.");
  const cases = corpus.filter((task) => task.split === split && (!caseIds || caseIds.includes(task.id)));
  if (!cases.length || caseIds?.some((id) => !cases.some((task) => task.id === id)))
    throw new Error("Unknown, empty or cross-split case selection.");
  const root = path.resolve(
    outputRoot ??
      path.join(
        "artifacts",
        "verification",
        `${new Date().toISOString().replace(/[:.]/gu, "-")}-assistant-parity-${split}`,
      ),
  );
  await fs.mkdir(root, { recursive: false });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  const sourceTree = await collectAssistantSourceFingerprint(process.cwd());
  const trackedPatchHash = sha256(
    execFileSync("git", ["diff", "--no-ext-diff"], {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
  const manifest = {
    version: "goatcitadel.assistant-parity.v1",
    mode,
    split,
    sourceHead: head,
    trackedPatchHash,
    sourceTreeSha256: sourceTree.sha256,
    sourceFileCount: sourceTree.fileCount,
    corpusSha256: frozen.corpusSha256,
    productRefs:
      mode === "live"
        ? Object.fromEntries(products.map((product) => [product, providerConfig.products?.[product]?.productRef]))
        : { goatcitadel: head, ...frozen.upstreamRefs },
    inspectedUpstreamRefs: frozen.upstreamRefs,
    nativeSessionsModuleSha256: providerConfig.nativeSessionsModule?.sha256,
    independenceDefinition: frozen.independenceDefinition,
    baselineDisposition: "post_change_observation; pre_change_review_probes_only",
    maxCostUsd: mode === "live" ? maxCostUsd : null,
    caveat:
      "Component fixtures verify invariants only. Native product/model behavior and comparative parity require separately metered live evidence.",
  };
  await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await fs.writeFile(path.join(root, "source-files.json"), JSON.stringify(sourceTree.entries, null, 2) + "\n", {
    flag: "wx",
  });
  const adapters = await createAssistantParityAdapters({
    mode,
    root,
    providerConfig,
    providerConfigBaseDir,
    maxCostUsd,
    manifest,
  });
  const rows = [];
  try {
    for (const product of products) {
      const config = providerConfig.products?.[product] ?? {
        model: "fixture:no-provider",
        reasoning: "none",
        tools: "isolated_synthetic",
        grants: "no_external_effects",
      };
      if (mode === "live" && (!config.productRef || !config.model || !config.configurationHash))
        throw new Error("Live adapter requires actual product/version/model/config bindings.");
      const productRef = mode === "fixture" ? manifest.productRefs[product] : config.productRef;
      const configurationHash = config.configurationHash ?? sha256(config);
      for (const task of cases) {
        const binding = {
          mode,
          product,
          productRef,
          configurationHash,
          model: config.model,
          caseId: task.id,
          independentTaskId: mode === "live" ? task.independentTaskId : `component:${task.independentTaskId}`,
          split: task.split,
        };
        const observed = adapters[product]
          ? await adapters[product].run({
              task,
              binding,
              remainingCostUsd:
                typeof maxCostUsd === "number"
                  ? Math.max(0, maxCostUsd - rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0))
                  : undefined,
            })
          : {
              ...binding,
              status: "not_run",
              reason: "native_adapter_unavailable",
              source: "unavailable",
              costUsd: null,
              usage: null,
            };
        validateAssistantParityReceipt(observed, binding, { maxCostUsd });
        const row = scoreAssistantCase(task, {
          ...observed,
          category: task.category,
          comparisonConfigurationHash: config.comparisonConfigurationHash ?? configurationHash,
        });
        rows.push(row);
        await fs.appendFile(path.join(root, "receipts.jsonl"), JSON.stringify(row) + "\n");
        if (
          mode === "live" &&
          ((row.costUsd === null && row.status !== "not_run") ||
            (maxCostUsd === 0
              ? rows.some((item) => (item.costUsd ?? 0) > 0)
              : rows.reduce((sum, item) => sum + (item.costUsd ?? 0), 0) >= maxCostUsd))
        )
          throw new Error("Comparison stopped at its cost ceiling or unknown paid usage.");
      }
    }
  } finally {
    await adapters.close?.();
  }
  if ((await collectAssistantSourceFingerprint(process.cwd())).sha256 !== sourceTree.sha256)
    throw new Error(
      "Product sources changed during the comparison; its results cannot be accepted as one source version.",
    );
  const comparison = compareAssistantProducts(rows);
  const report = {
    ...manifest,
    comparison,
    counts: Object.fromEntries(
      products.map((product) => [
        product,
        Object.fromEntries(
          ["passed", "failed", "not_run"].map((status) => [
            status,
            rows.filter((row) => row.product === product && row.status === status).length,
          ]),
        ),
      ]),
    ),
    outputRoot: root,
  };
  await fs.writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  return report;
}
