import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./shared.mjs";

const ARCHITECTURE_BASELINE_PATH = path.join(repoRoot, "scripts", "verification", "baselines", "architecture-metrics.json");

export async function collectArchitectureMetrics(rootDir = repoRoot) {
  const gatewaySrcDir = path.join(rootDir, "apps", "gateway", "src");
  const routesDir = path.join(rootDir, "apps", "gateway", "src", "routes");
  const servicesDir = path.join(rootDir, "apps", "gateway", "src", "services");
  const gatewayServicePath = path.join(servicesDir, "gateway-service.ts");
  const gatewayRuntimeFactoryPath = path.join(servicesDir, "gateway-runtime-factory.ts");
  const serviceContextPath = path.join(servicesDir, "service-context.ts");
  const buildServiceContextPath = path.join(servicesDir, "gateway", "build-service-context.ts");

  const routeFiles = await listFiles(routesDir, (filePath) => filePath.endsWith(".ts"));
  const gatewaySourceFiles = await listFiles(
    gatewaySrcDir,
    (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"),
  );
  const serviceFiles = await listFiles(
    servicesDir,
    (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"),
  );
  const routeFacingServiceFiles = serviceFiles.filter((filePath) => filePath.endsWith("-route-service.ts"));
  const gatewayServiceSource = await fs.readFile(gatewayServicePath, "utf8");

  const hostCallbacksByFile = {};
  let totalHostCallbacks = 0;
  for (const filePath of serviceFiles) {
    if (filePath === gatewayServicePath) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    const count = countMatches(content, /\bhost\./g);
    if (count > 0) {
      hostCallbacksByFile[path.relative(rootDir, filePath).replaceAll("\\", "/")] = count;
      totalHostCallbacks += count;
    }
  }

  const fastifyGatewayCallSitesByRouteFile = await countPatternByFile(routeFiles, /fastify\.gateway\./g, rootDir);
  const fastifyGatewayCallSites = Object.values(fastifyGatewayCallSitesByRouteFile).reduce(
    (total, count) => total + count,
    0,
  );
  const gatewayInternalPublicCount = countMatches(gatewayServiceSource, /\/\*\* @internal \*\/ public/g);
  const gatewayPublicMethodsByRegion = countGatewayPublicMethodsByRegion(gatewayServiceSource);
  const gatewayInternalPublicByRegion = countGatewayInternalPublicByRegion(gatewayServiceSource);
  const gatewayLineCount = countLines(gatewayServiceSource);
  const gatewayPublicMethodCount = countMatches(
    gatewayServiceSource,
    /^\s*(?:\/\*\* @internal \*\/\s*)?public\s+(?:async\s+)?(?:get\s+|set\s+)?[$A-Z_a-z][$\w]*\s*\(/gm,
  );
  const boundGatewayRoutePortMethodCount = await countBoundGatewayRoutePortMethods(
    await fs.readFile(path.join(servicesDir, "gateway-route-services.ts"), "utf8"),
    serviceFiles,
  );
  const chatTurnRuntimeConstructedWithGatewayCount = countMatches(
    gatewayServiceSource,
    /new\s+ChatTurnRuntimeService\s*\(\s*this\s*\)/g,
  );
  const fastifyGatewayDecoratorReferenceCount = await countFastifyGatewayDecoratorReferences(gatewaySrcDir);
  const gatewayServiceImportConsumers = await collectImportConsumers({
    rootDir,
    filePaths: gatewaySourceFiles,
    excludedPaths: new Set([gatewayServicePath, gatewayRuntimeFactoryPath]),
    importPattern: /from\s+["'][^"']*gateway-service\.js["']/,
  });
  const serviceContextConsumers = await collectImportConsumers({
    rootDir,
    filePaths: serviceFiles,
    excludedPaths: new Set([serviceContextPath, buildServiceContextPath]),
    importPattern: /from\s+["'][^"']*service-context\.js["']/,
  });

  return {
    generatedAt: new Date().toISOString(),
    gatewayLineCount,
    gatewayPublicMethodCount,
    gatewayPublicMethodsByRegion,
    gatewayServiceImportConsumerCount: gatewayServiceImportConsumers.length,
    gatewayServiceImportConsumers,
    fastifyGatewayCallSites,
    fastifyGatewayCallSitesByRouteFile,
    gatewayInternalPublicCount,
    gatewayInternalPublicByRegion,
    boundGatewayRoutePortMethodCount,
    chatTurnRuntimeConstructedWithGatewayCount,
    fastifyGatewayDecoratorReferenceCount,
    serviceContextConsumerCount: serviceContextConsumers.length,
    serviceContextConsumers,
    totalHostCallbacks,
    hostCallbacksByFile,
    settingsHostCallbackCount: hostCallbacksByFile["apps/gateway/src/services/settings-auth-service.ts"] ?? 0,
    chatHostCallbackCount: sumMatchingValues(hostCallbacksByFile, /^apps\/gateway\/src\/services\/chat-/),
    routeFacingServiceCount: routeFacingServiceFiles.length,
    routeFacingServiceFiles: routeFacingServiceFiles
      .map((filePath) => path.relative(rootDir, filePath).replaceAll("\\", "/"))
      .sort(),
  };
}

export async function readArchitectureMetricsBaseline(rootDir = repoRoot) {
  const baselinePath = path.join(rootDir, "scripts", "verification", "baselines", "architecture-metrics.json");
  const raw = await fs.readFile(baselinePath, "utf8");
  return JSON.parse(raw);
}

export function compareArchitectureMetrics(metrics, baseline) {
  const regressions = [];
  const improvements = [];
  const deltas = {
    gatewayLineCount: metrics.gatewayLineCount - baseline.gatewayLineCount,
    gatewayPublicMethodCount: metrics.gatewayPublicMethodCount - baseline.gatewayPublicMethodCount,
    gatewayServiceImportConsumerCount:
      metrics.gatewayServiceImportConsumerCount - baseline.gatewayServiceImportConsumerCount,
    fastifyGatewayCallSites: metrics.fastifyGatewayCallSites - baseline.fastifyGatewayCallSites,
    gatewayInternalPublicCount: metrics.gatewayInternalPublicCount - baseline.gatewayInternalPublicCount,
    boundGatewayRoutePortMethodCount:
      metrics.boundGatewayRoutePortMethodCount - (baseline.boundGatewayRoutePortMethodCount ?? metrics.boundGatewayRoutePortMethodCount),
    chatTurnRuntimeConstructedWithGatewayCount:
      metrics.chatTurnRuntimeConstructedWithGatewayCount -
      (baseline.chatTurnRuntimeConstructedWithGatewayCount ?? metrics.chatTurnRuntimeConstructedWithGatewayCount),
    fastifyGatewayDecoratorReferenceCount:
      metrics.fastifyGatewayDecoratorReferenceCount -
      (baseline.fastifyGatewayDecoratorReferenceCount ?? metrics.fastifyGatewayDecoratorReferenceCount),
    serviceContextConsumerCount: metrics.serviceContextConsumerCount - baseline.serviceContextConsumerCount,
    totalHostCallbacks: metrics.totalHostCallbacks - baseline.totalHostCallbacks,
    settingsHostCallbackCount:
      metrics.settingsHostCallbackCount - (baseline.settingsHostCallbackCount ?? metrics.settingsHostCallbackCount),
    chatHostCallbackCount: metrics.chatHostCallbackCount - (baseline.chatHostCallbackCount ?? metrics.chatHostCallbackCount),
    routeFacingServiceCount: metrics.routeFacingServiceCount - baseline.routeFacingServiceCount,
  };

  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayLineCount",
    label: "GatewayService line count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayPublicMethodCount",
    label: "GatewayService public method count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayServiceImportConsumerCount",
    label: "gateway-service.js import consumer count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "fastifyGatewayCallSites",
    label: "fastify.gateway.* call sites",
    regressions,
    improvements,
  });
  comparePerFileNonIncreasingMetric({
    metricsByFile: metrics.fastifyGatewayCallSitesByRouteFile,
    baselineByFile: baseline.fastifyGatewayCallSitesByRouteFile,
    label: "fastify.gateway.* route call sites",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "gatewayInternalPublicCount",
    label: "GatewayService @internal public count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "boundGatewayRoutePortMethodCount",
    label: "Gateway-bound route port method count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "chatTurnRuntimeConstructedWithGatewayCount",
    label: "ChatTurnRuntimeService full-gateway construction count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "fastifyGatewayDecoratorReferenceCount",
    label: "fastify.gateway decorator/reference count outside compatibility tests",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "serviceContextConsumerCount",
    label: "broad ServiceContext consumer count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "settingsHostCallbackCount",
    label: "settings/auth host.* callback count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "chatHostCallbackCount",
    label: "chat host.* callback count",
    regressions,
    improvements,
  });
  compareNonIncreasingMetric({
    metrics,
    baseline,
    key: "totalHostCallbacks",
    label: "Extracted-service host.* callbacks",
    regressions,
    improvements,
  });

  if (metrics.routeFacingServiceCount < baseline.routeFacingServiceCount) {
    regressions.push(
      `Route-facing service count decreased from ${baseline.routeFacingServiceCount} to ${metrics.routeFacingServiceCount}`,
    );
  } else if (metrics.routeFacingServiceCount > baseline.routeFacingServiceCount) {
    improvements.push(
      `Route-facing service count increased from ${baseline.routeFacingServiceCount} to ${metrics.routeFacingServiceCount}`,
    );
  }

  return {
    baselinePath: ARCHITECTURE_BASELINE_PATH,
    deltas,
    regressions,
    improvements,
    status: regressions.length > 0 ? "failed" : "passed",
  };
}

async function listFiles(rootDir, predicate) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return listFiles(fullPath, predicate);
      }
      if (predicate(fullPath)) {
        return [fullPath];
      }
      return [];
    }),
  );
  return files.flat();
}

async function countPatternAcrossFiles(filePaths, pattern) {
  let total = 0;
  for (const filePath of filePaths) {
    const content = await fs.readFile(filePath, "utf8");
    total += countMatches(content, pattern);
  }
  return total;
}

async function countPatternByFile(filePaths, pattern, rootDir) {
  const counts = {};
  const sortedFilePaths = [...filePaths].sort();
  for (const filePath of sortedFilePaths) {
    const content = await fs.readFile(filePath, "utf8");
    const count = countMatches(content, pattern);
    if (count > 0) {
      counts[path.relative(rootDir, filePath).replaceAll("\\", "/")] = count;
    }
  }
  return counts;
}

function countGatewayPublicMethodsByRegion(source) {
  const counts = {};
  for (const method of collectGatewayPublicMethods(source)) {
    const region = classifyGatewayMethodRegion(method.name);
    counts[region] = (counts[region] ?? 0) + 1;
  }
  return sortObjectByKey(counts);
}

function countGatewayInternalPublicByRegion(source) {
  const counts = {};
  for (const method of collectGatewayPublicMethods(source)) {
    if (!method.internal) {
      continue;
    }
    const region = classifyGatewayMethodRegion(method.name);
    counts[region] = (counts[region] ?? 0) + 1;
  }
  return sortObjectByKey(counts);
}

function collectGatewayPublicMethods(source) {
  const methods = [];
  const pattern =
    /^\s*(?<internal>\/\*\* @internal \*\/\s*)?public\s+(?:async\s+)?(?:(?:get|set)\s+)?(?<name>[$A-Z_a-z][$\w]*)\s*\(/gm;
  for (const match of source.matchAll(pattern)) {
    const name = match.groups?.name;
    if (!name) {
      continue;
    }
    methods.push({
      name,
      internal: Boolean(match.groups?.internal),
    });
  }
  return methods;
}

function classifyGatewayMethodRegion(methodName) {
  if (/^(init|initCritical|startDeferredInit|close|attachDevDiagnosticsLogger|isDevDiagnosticsEnabled)$/.test(methodName)) {
    return "lifecycle";
  }
  if (/^(createApproval|resolveApproval|listApprovals|getApproval|ensureApproval|enqueueApproval|primeApproval|buildApproval|findProactiveDurableRunIdsForApproval|consumeRemoteActionToken)/.test(methodName)) {
    return "approvals";
  }
  if (/^(agentSendChatMessage|retryChatTurn|editChatTurn|cancelChatTurn|routePreflight|resumeAgentChatTurnStream|answerChatUserInputPrompt|prepareAgentChatTurn|beginActiveChatTurn|endActiveChatTurn|getActiveChatTurn|registerActiveChatTurn|completeActiveChatTurn|closeActiveChatTurn|persistChatStreamChunk|createHydratedChatTurnTrace|markChatTurnCancelled|loadChatTurn|requireChatTurn|buildChat|resolvePreparedTurn|collectSpecialist|extractAndPersistLearnedMemory|ensureChatSessionRuntimeGrants|inheritDelegatedSessionToolGrants|runPromptPackFromChat)/.test(methodName)) {
    return "chat-turn-runtime";
  }
  if (/^(listChat|createChat|updateChat|pinChat|unpinChat|archiveChat|restoreChat|deleteChat|assignChat|getChatSession|getChatThread|selectChatBranch|setChatSession|respondToExistingChatMessage|uploadChatAttachment|getChatAttachment|readChatAttachment|listChatGenerated|createChatGenerated|getChatGenerated|attachChatThread|removeChatThread|listChatThread)/.test(methodName)) {
    return "chat-sessions";
  }
  if (/^(listPromptPack|importPromptPack|runPromptPack|scorePromptPack|reviewPromptPack|autoScorePromptPack|getPromptPack|cancelPromptPack|exportPromptPack|resetPromptPack)/.test(methodName)) {
    return "prompt-packs";
  }
  if (/^(getDurable|listDurable|createDurable|pauseDurable|resumeDurable|cancelDurable|retryDurable|wakeDurable|recoverDurable|beginDurable|finalizeDurable|requestDurable|updateDurable|computeDurable|recordDurable|createCheckpoint)/.test(methodName)) {
    return "durable";
  }
  if (/^(getMemory|patchMemory|listMemory|runMemory|acceptMemory|rejectMemory|forgetMemory|composeMemory|listRunContexts|listRecentMemory|persistContext|resolveMemory)/.test(methodName)) {
    return "memory";
  }
  if (/^(getSettings|updateSettings|getAuth|updateAuth|resolveGatewayInstallToken|createDeviceAccess|getDeviceAccess|listDeviceAccess|revokeDeviceAccess|validateDeviceAccess|exchangeCompanion|rotateCompanion|getCompanion|listCompanion|revokeCompanion|validateCompanion|verifyCompanion|resolveDeviceAccess|expireDeviceAccess|recordApprovalResolution)/.test(methodName)) {
    return "settings-auth";
  }
  if (/^(listIntegration|getIntegration|createIntegration|updateIntegration|deleteIntegration|invokeIntegration|runIntegration|listChannel|createChannel|updateChannel|validateChannel|testChannel|finalizeChannel|retestChannel|listDiscord|approveDiscord|revokeDiscord|getDiscord|reconnectDiscord|emitDiscord|emitTelegram|syncDiscord|ingestChannel|assertDiscord|readDiscord|writeDiscord|resolveDiscord|ensureDiscord|startNewDiscord|handleDiscord|readConnection|resolveConnection|recordConnector|pickConnector|buildIntegration|runIntegrationConnectionLiveChecks|listConnector)/.test(methodName)) {
    return "integrations";
  }
  if (/^(listMcp|runMcp|createMcp|updateMcp|deleteMcp|connectMcp|disconnectMcp|startMcp|completeMcp|invokeMcp|readMcp|writeMcp|requireMcp|patchMcp|resolveConnectedMcp)/.test(methodName)) {
    return "mcp";
  }
  if (/^(invokeTool|listTool|evaluateTool|createToolGrant|revokeToolGrant|ensureSessionInternalToolGrant|requireExecutedToolResult|comms|knowledge)/.test(methodName)) {
    return "tools-comms";
  }
  if (/^(listSkills|reloadSkills|executeCodeMode|listChatPendingApprovals|getSkill|updateSkill|setSkill|bulkSetSkill|resolveSkill|listSkill|lookupSkill|validateSkill|installSkill|getBankr|updateBankr|previewBankr|listBankr)/.test(methodName)) {
    return "skills";
  }
  if (/^(getDashboard|getSystem|listOperators|listCron|getCron|createCron|updateCron|setCron|deleteCron|runCron|retryCron|uploadWorkspace|listWorkspace|createWorkspace|updateWorkspace|archiveWorkspace|restoreWorkspace|listFile|createWorkspaceFile|downloadWorkspace|listGlobalGuidance|listWorkspaceGuidance|updateGlobalGuidance|updateWorkspaceGuidance|getTranscript|getSessionSummary|listSessionTimeline|getRuntimeLifecycle|listSessions|getSession|getLatestFollowOn|rememberFollowOn|getPackaging|getVoice)/.test(methodName)) {
    return "dashboard-workspace";
  }
  if (/^(listLlm|getLlm|updateLlm|previewLlm|createChatCompletion|resolveFallbackTargets|saveProviderSecret|deleteProviderSecret|getProviderSecret|listLlama|getLlama|startLlama|stopLlama|refreshLlama|detectLlama|adviseLlama|cancelLlama|listNpu|getNpu|startNpu|stopNpu|refreshNpu|generateImage|createAssembly|listAssembly|getAssembly)/.test(methodName)) {
    return "runtime-provider";
  }
  if (/^(publishRealtime|subscribeRealtime|listRealtime|getRealtime|openRealtime|touchRealtime|closeRealtime|ingestEvent|listDev|subscribeDev|recordDev)/.test(methodName)) {
    return "realtime-events";
  }
  if (/^(createOrchestration|runOrchestration|approvePhase|getRun|listRunCheckpoints|allocateOrchestration|executeDurableOrchestration|scheduleOrchestration|parseOrchestration|applyOrchestration)/.test(methodName)) {
    return "orchestration";
  }
  if (/^(isFeatureEnabled|requireFeatureEnabled|updateFeatureFlags|readFeatureFlags|persist|assert|runCheaper|fetchWithDiagnosticsTimeout|isConnectionUrlAllowlisted|isUrlAllowlistedInList|normalizeWorkspaceId|resolveChatCompletionHookWorkspaceId|resolveApprovalHookWorkspaceId|parseLlm|mergeLlm|applyLlm|resolveRuntimeGuidance|routeFromSession|buildLlmMessagesFromBranchPath|gatewaySql)$/.test(methodName)) {
    return "composition-helpers";
  }
  return "other";
}

async function countBoundGatewayRoutePortMethods(source, serviceFiles) {
  const match = source.match(/export function createBoundGatewayRouteServiceDependencies[\s\S]*?\n}\n/);
  if (!match) {
    return 0;
  }
  let total = 0;
  for (const call of match[0].matchAll(/bindRoutePort\(\s*source\s*,\s*([A-Za-z0-9_]+)\s*\)/g)) {
    const methodsName = call[1];
    const declaration = await findExportedConstArrayDeclaration(methodsName, serviceFiles);
    if (!declaration) {
      continue;
    }
    total += countMatches(declaration, /"[^"]+"/g);
  }
  return total;
}

async function findExportedConstArrayDeclaration(name, serviceFiles) {
  const pattern = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`);
  for (const filePath of serviceFiles) {
    const source = await fs.readFile(filePath, "utf8");
    const match = source.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

async function countFastifyGatewayDecoratorReferences(gatewaySrcDir) {
  const files = await listFiles(
    gatewaySrcDir,
    (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"),
  );
  let total = 0;
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    total += countMatches(content, /\b(?:fastify|app|built|next)\.gateway\b/g);
    total += countMatches(content, /\bFastifyInstance\s*&\s*\{\s*gateway\??\s*:/g);
    total += countMatches(content, /decorate\(\s*["']gateway["']/g);
  }
  return total;
}

function sumMatchingValues(record, pattern) {
  return Object.entries(record).reduce((total, [key, value]) => (pattern.test(key) ? total + value : total), 0);
}

function sortObjectByKey(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function countMatches(content, pattern) {
  const matches = content.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}

function countLines(content) {
  if (content.length === 0) {
    return 0;
  }
  return content.split(/\r?\n/).length;
}

async function collectImportConsumers({ rootDir, filePaths, excludedPaths, importPattern }) {
  const consumers = [];
  for (const filePath of [...filePaths].sort()) {
    if (excludedPaths.has(filePath)) {
      continue;
    }
    const content = await fs.readFile(filePath, "utf8");
    if (importPattern.test(content)) {
      consumers.push(path.relative(rootDir, filePath).replaceAll("\\", "/"));
    }
  }
  return consumers;
}

function compareNonIncreasingMetric({ metrics, baseline, key, label, regressions, improvements }) {
  if (typeof baseline[key] !== "number") {
    return;
  }
  if (metrics[key] > baseline[key]) {
    regressions.push(`${label} increased from ${baseline[key]} to ${metrics[key]}`);
  } else if (metrics[key] < baseline[key]) {
    improvements.push(`${label} decreased from ${baseline[key]} to ${metrics[key]}`);
  }
}

function comparePerFileNonIncreasingMetric({ metricsByFile = {}, baselineByFile = {}, label, regressions, improvements }) {
  const filePaths = new Set([...Object.keys(metricsByFile), ...Object.keys(baselineByFile)]);
  for (const filePath of [...filePaths].sort()) {
    const current = metricsByFile[filePath] ?? 0;
    const previous = baselineByFile[filePath] ?? 0;
    if (current > previous) {
      regressions.push(`${label} increased in ${filePath} from ${previous} to ${current}`);
    } else if (current < previous) {
      improvements.push(`${label} decreased in ${filePath} from ${previous} to ${current}`);
    }
  }
}
