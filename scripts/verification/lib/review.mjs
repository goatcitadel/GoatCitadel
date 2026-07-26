import path from "node:path";
import {
  clampString,
  readJson,
  validateRepairPlanPayload,
  validateReviewPayload,
  writeJson,
  writeText,
} from "./shared.mjs";

export async function loadManifestForReview(artifactRoot) {
  return readJson(path.join(artifactRoot, "manifest.json"));
}

export function validateExplicitReviewTarget(input) {
  const { artifactRoot, latestPointer, manifest } = input;
  const expectedRunId = String(input.expectedRunId ?? "").trim();
  const expectedLane = String(input.expectedLane ?? "all").trim();
  const startedAfter = String(input.startedAfter ?? "").trim();

  if (!expectedRunId && !startedAfter) {
    throw new Error(
      "Verification review requires an explicit freshness guard: pass --run-id=<runId> or --started-after=<ISO timestamp>.",
    );
  }
  if (!latestPointer?.runId || !manifest?.runId) {
    throw new Error("Verification review requires matching run ids in the latest-run pointer and manifest.");
  }
  if (latestPointer.runId !== manifest.runId) {
    throw new Error(
      `Latest verification pointer run ${latestPointer.runId} does not match manifest run ${manifest.runId}.`,
    );
  }
  if (expectedRunId && expectedRunId !== manifest.runId) {
    throw new Error(`Expected verification run ${expectedRunId}, but latest finalized run is ${manifest.runId}.`);
  }
  if (!sameResolvedPath(latestPointer.artifactRoot, artifactRoot)) {
    throw new Error("Latest verification pointer artifact path does not match the selected review artifact path.");
  }
  if (!manifest.artifactRoot || !sameResolvedPath(manifest.artifactRoot, artifactRoot)) {
    throw new Error("Verification manifest artifact path does not match the latest-run pointer.");
  }
  if (path.basename(path.resolve(artifactRoot)) !== manifest.runId) {
    throw new Error("Verification manifest run id does not match its artifact directory name.");
  }
  if (!expectedLane) {
    throw new Error("Verification review requires a non-empty expected lane.");
  }
  if (manifest.lane !== expectedLane) {
    throw new Error(
      `Explicit verification review expected lane ${expectedLane}, but received ${manifest.lane ?? "unknown"}.`,
    );
  }
  if (!manifest.finishedAt || !["passed", "failed", "degraded"].includes(manifest.status)) {
    throw new Error("Verification review refuses a running or unfinalized manifest.");
  }

  const startedAtMs = Date.parse(String(manifest.startedAt ?? ""));
  const finishedAtMs = Date.parse(String(manifest.finishedAt));
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(finishedAtMs) || finishedAtMs < startedAtMs) {
    throw new Error("Verification review requires valid, ordered manifest start and finish timestamps.");
  }
  if (startedAfter) {
    const startedAfterMs = Date.parse(startedAfter);
    if (!Number.isFinite(startedAfterMs)) {
      throw new Error(`Invalid --started-after timestamp: ${startedAfter}`);
    }
    if (startedAtMs < startedAfterMs) {
      throw new Error(
        `Latest finalized verification run started at ${manifest.startedAt}, before required freshness boundary ${startedAfter}.`,
      );
    }
  }

  return manifest;
}

export async function generateVerificationReview(context, options = {}) {
  const manifest = options.manifest ?? (await loadManifestForReview(context.artifactRoot));
  const items = manifest.scenarios
    .filter((item) => item.status === "failed" || item.status === "degraded")
    .map((item) => buildReviewItem(item));
  if (items.length === 0 && (manifest.status === "failed" || manifest.status === "degraded")) {
    items.push(buildManifestFailureItem(manifest));
  }
  const review = validateReviewPayload({
    runId: manifest.runId,
    generatedAt: new Date().toISOString(),
    status: items.length > 0 ? "issues_found" : "ok",
    items,
    summary: {
      totalFailures: items.length,
      critical: items.filter((item) => item.severity === "critical").length,
      high: items.filter((item) => item.severity === "high").length,
      medium: items.filter((item) => item.severity === "medium").length,
      low: items.filter((item) => item.severity === "low").length,
    },
  });

  await writeJson(path.join(context.artifactRoot, "review.json"), review);
  const repairPlan = await buildRepairPlan(context, manifest, review, options);
  await writeText(path.join(context.artifactRoot, "repair-plan.md"), renderRepairPlanMarkdown(repairPlan));
  return { review, repairPlan };
}

function buildReviewItem(item) {
  const family = classifyFailureFamily(item);
  const severity = classifySeverity(item, family);
  return {
    scenarioId: item.id,
    title: item.title,
    subsystem: item.subsystem,
    severity,
    family,
    summary: clampString(item.error || item.notes.join("; ") || `${item.title} ${item.status}`, 260),
    likelySurfaces: deriveLikelySurfaces(item, family),
    artifacts: collectArtifactRefs(item.artifacts),
    checklist: buildChecklist(item, family),
  };
}

function buildManifestFailureItem(manifest) {
  return {
    scenarioId: `${manifest.lane}.manifest`,
    title: `${manifest.lane} verification manifest finalized as ${manifest.status}`,
    subsystem: "verification",
    severity: manifest.status === "failed" ? "high" : "medium",
    family: "unknown",
    summary: `The run finalized as ${manifest.status} without a failed or degraded scenario record.`,
    likelySurfaces: ["scripts/verification"],
    artifacts: ["manifest.json", "summary.md"],
    checklist: [
      "Inspect the manifest, summary, and process diagnostics for a setup or finalization failure.",
      "Re-run the failed verification lane after repairing the manifest-level failure.",
    ],
  };
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.resolve(String(left));
  const normalizedRight = path.resolve(String(right));
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function classifyFailureFamily(item) {
  const haystack = `${item.title} ${item.error ?? ""} ${item.notes.join(" ")} ${item.subsystem}`.toLowerCase();
  if (/accessibility|axe-core|\baxe\b|wcag|focus-visible/.test(haystack)) {
    return "accessibility";
  }
  if (/401|403|auth|authentication failed|api key|missing secret/.test(haystack)) {
    return "provider_auth";
  }
  if (/timeout|provider unavailable|service unavailable|429|rate limit|network/.test(haystack)) {
    return "provider_outage";
  }
  if (/blank|render|locator|selector|thread|dom|visible/.test(haystack)) {
    return "client_render";
  }
  if (/sse|stream|event stream|reconnect/.test(haystack)) {
    return "sse";
  }
  if (/refresh/.test(haystack)) {
    return "refresh_storm";
  }
  if (/orchestration|route mismatch|workflow|delegation/.test(haystack)) {
    return "orchestration_route_mismatch";
  }
  if (/install|bootstrap|onboard|launcher/.test(haystack)) {
    return "install_failure";
  }
  if (/addon|arena|launchurl|display-ready/.test(haystack)) {
    return "addon_readiness";
  }
  if (/voice|whisper|ffmpeg|transcribe|model/.test(haystack)) {
    return "voice_runtime_failure";
  }
  if (/longtask|jank|perf|latency|scroll/.test(haystack)) {
    return "visual_perf_regression";
  }
  if (/skip|unsupported|not configured|environment/.test(haystack)) {
    return "environment";
  }
  return "unknown";
}

function classifySeverity(item, family) {
  if (item.status === "degraded") {
    return family === "visual_perf_regression" ? "medium" : "low";
  }
  if (["install_failure", "client_render", "sse"].includes(family)) {
    return "critical";
  }
  if (family === "accessibility") {
    return "high";
  }
  if (["provider_auth", "voice_runtime_failure", "addon_readiness", "orchestration_route_mismatch"].includes(family)) {
    return "high";
  }
  if (["provider_outage", "visual_perf_regression"].includes(family)) {
    return "medium";
  }
  return "low";
}

function deriveLikelySurfaces(item, family) {
  const surfaces = new Set([item.subsystem]);
  if (family === "client_render") {
    // W5 Phase 1: legacy `apps/mission-control` retired; next is the only client renderer.
    surfaces.add("apps/mission-control-next");
  }
  if (family === "accessibility") {
    surfaces.add("apps/mission-control-next");
  }
  if (family === "sse") {
    surfaces.add("apps/mission-control-next/src/main.tsx");
    surfaces.add("apps/gateway/src/routes/gateway-events.ts");
  }
  if (family === "provider_auth" || family === "provider_outage") {
    surfaces.add("apps/gateway/src/services/llm-service.ts");
  }
  if (family === "orchestration_route_mismatch") {
    surfaces.add("apps/gateway/src/orchestration");
  }
  if (family === "voice_runtime_failure") {
    surfaces.add("apps/gateway/src/voice-runtime");
  }
  if (family === "addon_readiness") {
    surfaces.add("apps/gateway/src/services/addons-service.ts");
  }
  return [...surfaces];
}

function collectArtifactRefs(artifacts) {
  return [
    ...artifacts.diagnostics,
    ...artifacts.screenshots,
    ...artifacts.logs,
    ...artifacts.perf,
    ...artifacts.playwright,
    ...artifacts.traces,
  ];
}

function buildChecklist(item, family) {
  const checklist = [
    `Review diagnostics and artifacts for scenario \`${item.id}\`.`,
    `Re-run the failing scenario in isolation with correlation id \`${item.correlationId ?? "n/a"}\`.`,
  ];
  if (family === "provider_auth") {
    checklist.push("Validate provider secret resolution and active model selection.");
  }
  if (family === "client_render") {
    checklist.push("Inspect browser diagnostics bundle and screenshot for render-path decisions.");
  }
  if (family === "sse") {
    checklist.push("Inspect SSE lifecycle, reconnect logic, and refresh-bus emissions.");
  }
  if (family === "voice_runtime_failure") {
    checklist.push("Verify managed voice runtime state, selected model, and helper binaries.");
  }
  if (family === "addon_readiness") {
    checklist.push("Check add-on installation state, launch health, and external URL readiness.");
  }
  if (family === "visual_perf_regression") {
    checklist.push("Review performance artifacts for long tasks, effects mode, and scroll jank.");
  }
  if (family === "accessibility") {
    checklist.push(
      "Review the axe rule targets, keyboard focus sample, and captured route state before changing UI semantics.",
    );
  }
  return checklist;
}

async function buildRepairPlan(context, manifest, review, options) {
  const deterministic = {
    runId: manifest.runId,
    generatedAt: new Date().toISOString(),
    mode: "deterministic",
    summary:
      review.items.length > 0
        ? `Focus first on ${review.items[0].subsystem}: ${review.items[0].summary}`
        : "No failing scenarios were recorded in the latest verification run.",
    priorities: review.items.slice(0, 5).map((item) => `${item.severity.toUpperCase()}: ${item.title}`),
    recommendedReruns: deriveRecommendedReruns(review.items),
  };

  const gatewayUrl = options.reviewGatewayUrl ?? process.env.GOATCITADEL_VERIFY_REVIEW_GATEWAY_URL;
  if (!gatewayUrl || review.items.length === 0) {
    return validateRepairPlanPayload(deterministic);
  }

  try {
    const prompt = buildAiRepairPrompt(manifest, review);
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/api/v1/llm/chat-completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "You are a release verification reviewer. Produce a terse prioritized repair plan with numbered actions and reruns.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`review gateway returned ${response.status}`);
    }
    const payload = await response.json();
    const aiText = payload?.choices?.[0]?.message?.content;
    if (typeof aiText !== "string" || aiText.trim().length === 0) {
      throw new Error("review gateway returned empty content");
    }
    return validateRepairPlanPayload({
      ...deterministic,
      mode: "ai_assisted",
      summary: deterministic.summary,
      rawModelOutput: aiText,
    });
  } catch {
    return validateRepairPlanPayload(deterministic);
  }
}

function deriveRecommendedReruns(items) {
  const reruns = new Set();
  for (const item of items) {
    if (item.subsystem === "fast") {
      reruns.add("pnpm verify:fast");
    } else if (item.subsystem === "core-browser" || item.subsystem === "chat" || item.subsystem === "shell") {
      reruns.add("pnpm verify:deep:core");
    } else if (
      item.subsystem === "ecosystem" ||
      item.family === "voice_runtime_failure" ||
      item.family === "addon_readiness"
    ) {
      reruns.add("pnpm verify:deep:ecosystem");
    } else if (item.family === "visual_perf_regression") {
      reruns.add("pnpm verify:deep:core");
    } else if (item.family === "accessibility") {
      reruns.add("pnpm verify:accessibility:smoke");
    }
  }
  if (reruns.size === 0) {
    reruns.add("pnpm verify:fast");
  }
  return [...reruns];
}

function buildAiRepairPrompt(manifest, review) {
  return [
    `Verification run: ${manifest.runId}`,
    `Lane: ${manifest.lane}`,
    `Status: ${manifest.status}`,
    "",
    "Failing scenarios:",
    ...review.items.map(
      (item, index) =>
        `${index + 1}. [${item.severity}] ${item.subsystem} :: ${item.title}\n   Family: ${item.family}\n   Summary: ${item.summary}\n   Likely surfaces: ${item.likelySurfaces.join(", ")}`,
    ),
    "",
    "Produce:",
    "1. A short root-cause summary.",
    "2. An ordered fix-first list.",
    "3. Recommended rerun commands.",
  ].join("\n");
}

function renderRepairPlanMarkdown(plan) {
  const lines = [
    `# Verification Repair Plan (${plan.mode})`,
    "",
    `- Run: \`${plan.runId}\``,
    `- Generated: ${plan.generatedAt}`,
    "",
    "## Summary",
    "",
    plan.summary,
    "",
    "## Priorities",
    "",
    ...plan.priorities.map((item) => `- ${item}`),
    "",
    "## Recommended Reruns",
    "",
    ...plan.recommendedReruns.map((item) => `- \`${item}\``),
  ];
  if (plan.rawModelOutput) {
    lines.push("", "## AI Review", "", plan.rawModelOutput);
  }
  lines.push("");
  return lines.join("\n");
}
