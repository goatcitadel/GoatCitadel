const INITIAL_ROUTE_NAVIGATION_MAX_ATTEMPTS = 2;
const INITIAL_ROUTE_READINESS_GRACE_MS = 5_000;
const INITIAL_ROUTE_TIMEOUT_REASON = "initial_navigation_timeout";

export function buildSurfaceCompatibilityInputs(verificationTarget) {
  const legacyRedirects = verificationTarget?.redirectRoutes ?? [];
  const directCompatibility = verificationTarget?.directCompatibilityRoutes ?? [];
  return [
    ...legacyRedirects.map((route) => ({
      ...route,
      compatibilityKind: "legacy-query-input",
      scenarioId: `surface-regression.redirect.${route.slug}`,
      scenarioTitle: `${route.slug} redirects into Mission Control Next`,
      artifactSlug: `surface-regression-redirect-${route.slug}`,
    })),
    ...directCompatibility.map((route) => ({
      ...route,
      compatibilityKind: "direct-path",
      scenarioId: `surface-regression.direct-compatibility.${route.slug}`,
      scenarioTitle: `${route.slug} direct compatibility path resolves in Mission Control Next`,
      artifactSlug: `surface-regression-direct-compatibility-${route.slug}`,
    })),
  ];
}

export async function runSurfaceRegressionLane(context, options = {}, deps) {
  const {
    appendTraceArtifact,
    assertBrowserConsoleHealthy,
    assertNativeStageScrollContract,
    assertProviderAnchorAndAdviceContract,
    assertLegacyRedirectResolution,
    attachBrowserLogging,
    buildVerificationUiUrl,
    captureBrowserArtifacts,
    chromium,
    ensureOnboardingComplete,
    installMissionControlNextBrowserState,
    NATIVE_SCROLL_HANDOFF_ROUTE_SLUGS,
    performVerificationInteraction,
    resolveVerificationTargetContext,
    runMissionControlNextMobileShellProof,
    runScenario,
    seedMissionControlNextFixture,
    setBrowserCorrelation,
    startBrowserTrace,
    startVerificationStack,
    stopVerificationStack,
    waitForMissionControlShell,
    waitForVerificationRouteReady,
  } = deps;
  const verificationTarget = resolveVerificationTargetContext();
  const surfaceOperatorToken = "verification-surface-regression-operator-token";
  const stack = await startVerificationStack(context, {
    includeUi: true,
    processLogPrefix: options.processLogPrefix,
    gatewayEnvOmit: options.secretEnvKeys,
    uiEnvOmit: options.secretEnvKeys,
    gatewayEnv: {
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: surfaceOperatorToken,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
      GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
      GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
      GOATCITADEL_MESH_NODE_ID: "build-main",
    },
    uiEnv: {
      VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-surface-regression");
    const fixture = verificationTarget.isNext
      ? await seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot })
      : null;
    const browser = await chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext({
        viewport: { width: 1440, height: 1024 },
        colorScheme: "dark",
      });
      if (fixture && verificationTarget.isNext) {
        await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
      }
      const page = await browserContext.newPage();
      const browserLog = attachBrowserLogging(page);

      for (const [routeIndex, route] of verificationTarget.surfaceRoutes.entries()) {
        await runScenario(
          context,
          {
            id: `surface-regression.${route.slug}`,
            lane: "surface-regression",
            title: `${route.slug} renders in Mission Control`,
            subsystem: "mission-control",
          },
          async ({ correlationId }) => {
            const browserLogCursor = browserLog.mark();
            const artifactSlug = `surface-regression-${route.slug}`;
            const trace = await startBrowserTrace(context, { page, slug: artifactSlug });
            let artifacts;
            let navigationEvidence = emptyNavigationEvidence();
            try {
              // Only the first read-only boot navigation can recover. Correlation and
              // interaction hooks run after this boundary and are never retried.
              const routeHref =
                verificationTarget.isNext && route.slug === "settings-providers"
                  ? `${route.href}#providers-routing`
                  : route.href;
              navigationEvidence = await navigateSurfaceRoute(page, buildVerificationUiUrl(stack.uiUrl, routeHref), {
                allowInitialColdStartRecovery: routeIndex === 0,
              });
              await waitForVerificationRouteReady(page, route, verificationTarget.packageName);
              if (verificationTarget.isNext && route.releaseStatus === "experimental") {
                await assertExperimentalSurfaceLabel(page, route.slug);
              }
              await setBrowserCorrelation(page, correlationId, fixture?.sessionId);
              let nativeScrollEvidence = null;
              if (verificationTarget.isNext && route.slug !== "chat" && route.slug !== "library-prompt-packs") {
                if (route.slug === "settings-providers") {
                  await assertProviderAnchorAndAdviceContract(page);
                }
                nativeScrollEvidence = await assertNativeStageScrollContract(page, {
                  label: route.slug,
                  probeNestedBoundary: NATIVE_SCROLL_HANDOFF_ROUTE_SLUGS.has(route.slug),
                });
              }
              await performVerificationInteraction(page, route.interaction, verificationTarget.packageName);
              const browserSanity = assertBrowserConsoleHealthy(
                browserLog,
                browserLogCursor,
                verificationTarget.packageName,
              );
              await page.waitForTimeout(250);
              artifacts = await captureBrowserArtifacts(context, {
                slug: artifactSlug,
                page,
                browserLog,
                gatewayUrl: stack.gatewayUrl,
                correlationId,
                logCursor: browserLogCursor,
              });
              let degradedStateEvidence = null;
              if (verificationTarget.isNext && route.releaseStatus === "experimental") {
                const degradedLogCursor = browserLog.mark();
                degradedStateEvidence = await assertExperimentalSurfaceDegradedState(page, {
                  gatewayUrl: stack.gatewayUrl,
                  routeHref,
                  routeSlug: route.slug,
                });
                await setBrowserCorrelation(page, correlationId, fixture?.sessionId);
                const degradedLog = browserLog.getSnapshot(degradedLogCursor);
                if (degradedLog.pageErrors.length > 0) {
                  throw new Error(
                    `experimental route ${route.slug} raised page errors under a deterministic Gateway outage`,
                  );
                }
                const degradedArtifacts = await captureBrowserArtifacts(context, {
                  slug: `${artifactSlug}-degraded`,
                  page,
                  browserLog,
                  gatewayUrl: stack.gatewayUrl,
                  correlationId,
                  logCursor: degradedLogCursor,
                });
                artifacts = mergeArtifactSets(artifacts, degradedArtifacts);
              }
              return {
                status: "passed",
                metrics: {
                  route: route.href,
                  consoleErrors: browserSanity.consoleErrors.length,
                  pageErrors: browserSanity.pageErrors.length,
                  navigationAttempts: navigationEvidence.attempts,
                  navigationRecoveryReason: navigationEvidence.recoveryReason,
                  navigationRecoveryDisposition: navigationEvidence.recoveryDisposition,
                  ...(degradedStateEvidence ?? {}),
                  ...(nativeScrollEvidence
                    ? {
                        nativeStageOverflowed: nativeScrollEvidence.overflowed,
                        nativeStageMaxScrollTop: nativeScrollEvidence.maxScrollTop,
                        nestedScrollHandoff: nativeScrollEvidence.nestedHandoff,
                      }
                    : {}),
                },
                artifacts,
              };
            } catch (error) {
              navigationEvidence = navigationEvidenceFromError(error) ?? navigationEvidence;
              const failureArtifacts = await captureBrowserArtifacts(context, {
                slug: `${artifactSlug}-failure`,
                page,
                browserLog,
                gatewayUrl: stack.gatewayUrl,
                correlationId,
                logCursor: browserLogCursor,
              });
              artifacts = mergeArtifactSets(artifacts, failureArtifacts);
              const traceArtifact = await trace.retain().catch(() => null);
              return {
                status: "failed",
                error: formatBrowserFailure(error),
                metrics: {
                  route: route.href,
                  navigationAttempts: navigationEvidence.attempts,
                  navigationRecoveryReason: navigationEvidence.recoveryReason,
                  navigationRecoveryDisposition: navigationEvidence.recoveryDisposition,
                },
                artifacts: appendTraceArtifact(artifacts, traceArtifact),
              };
            } finally {
              await trace.discard().catch(() => undefined);
            }
          },
        );
      }

      for (const redirect of buildSurfaceCompatibilityInputs(verificationTarget)) {
        const targetHref = redirect.targetHref ?? redirect.expectedPath;
        const route = verificationTarget.routeByHref.get(targetHref);
        if (!route) {
          throw new Error(`verification redirect target was not mapped: ${targetHref}`);
        }
        await runScenario(
          context,
          {
            id: redirect.scenarioId,
            lane: "surface-regression",
            title: redirect.scenarioTitle,
            subsystem: "mission-control",
          },
          async ({ correlationId }) => {
            const browserLogCursor = browserLog.mark();
            const artifactSlug = redirect.artifactSlug;
            const trace = await startBrowserTrace(context, { page, slug: artifactSlug });
            let artifacts;
            try {
              await page.goto(buildVerificationUiUrl(stack.uiUrl, redirect.href), { waitUntil: "domcontentloaded" });
              await waitForMissionControlShell(page, { packageName: verificationTarget.packageName });
              await assertLegacyRedirectResolution(page, redirect.expectedPath, redirect.expectedSearchParams);
              await waitForVerificationRouteReady(page, route, verificationTarget.packageName);
              await setBrowserCorrelation(page, correlationId, fixture?.sessionId);
              await performVerificationInteraction(
                page,
                redirect.interaction ?? route.interaction,
                verificationTarget.packageName,
              );
              const browserSanity = assertBrowserConsoleHealthy(
                browserLog,
                browserLogCursor,
                verificationTarget.packageName,
              );
              artifacts = await captureBrowserArtifacts(context, {
                slug: artifactSlug,
                page,
                browserLog,
                gatewayUrl: stack.gatewayUrl,
                correlationId,
                logCursor: browserLogCursor,
              });
              return {
                status: "passed",
                metrics: {
                  href: redirect.href,
                  expectedPath: redirect.expectedPath,
                  targetHref,
                  compatibilityKind: redirect.compatibilityKind,
                  consoleErrors: browserSanity.consoleErrors.length,
                  pageErrors: browserSanity.pageErrors.length,
                },
                artifacts,
              };
            } catch (error) {
              artifacts ??= await captureBrowserArtifacts(context, {
                slug: `${artifactSlug}-failure`,
                page,
                browserLog,
                gatewayUrl: stack.gatewayUrl,
                correlationId,
                logCursor: browserLogCursor,
              });
              const traceArtifact = await trace.retain().catch(() => null);
              return {
                status: "failed",
                error: formatBrowserFailure(error),
                metrics: {
                  href: redirect.href,
                  expectedPath: redirect.expectedPath,
                  targetHref,
                  compatibilityKind: redirect.compatibilityKind,
                },
                artifacts: appendTraceArtifact(artifacts, traceArtifact),
              };
            } finally {
              await trace.discard().catch(() => undefined);
            }
          },
        );
      }

      await browserContext.close();

      if (verificationTarget.isNext) {
        await runMissionControlNextMobileShellProof(context, {
          browser,
          gatewayUrl: stack.gatewayUrl,
          uiUrl: stack.uiUrl,
          workspaceId: fixture?.workspaceId ?? "default",
          sessionId: fixture?.sessionId,
          packageName: verificationTarget.packageName,
        });
      }
    } finally {
      await browser.close();
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function assertExperimentalSurfaceLabel(page, routeSlug) {
  const badge = page.locator('main .mc-next-experimental-badge[data-release-status="experimental"][role="note"]');
  await badge.waitFor({ state: "visible", timeout: 60_000 });
  if ((await badge.count()) !== 1 || !(await badge.isVisible())) {
    throw new Error(`experimental route ${routeSlug} has no unique visible on-surface Experimental badge`);
  }
  const [label, text] = await Promise.all([badge.getAttribute("aria-label"), badge.innerText()]);
  if (label !== "Experimental" || text.trim().toLocaleLowerCase() !== "experimental") {
    throw new Error(`experimental route ${routeSlug} has a malformed on-surface Experimental badge`);
  }
}

export async function assertExperimentalSurfaceDegradedState(page, input) {
  const apiPattern = `${input.gatewayUrl}/api/v1/**`;
  const targetPath = experimentalDegradedApiPath(input.routeSlug);
  let degradedApiRequests = 0;
  const rejectGatewayRequest = async (route) => {
    if (!new URL(route.request().url()).pathname.startsWith(targetPath)) {
      await route.continue();
      return;
    }
    degradedApiRequests += 1;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "USABILITY_FIXTURE_UNAVAILABLE", message: "Deterministic outage" } }),
    });
  };
  await page.route(apiPattern, rejectGatewayRequest);
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertExperimentalSurfaceLabel(page, input.routeSlug);
    const main = page.locator("main");
    if (!(await main.isVisible())) throw new Error(`experimental route ${input.routeSlug} lost its main surface`);
    // Route loaders also use role=status. Waiting on the first live region can
    // therefore certify the transient "Loading..." projection before the
    // deterministic 503 reaches the route owner. Only a non-loader live region
    // can satisfy the degraded-state contract.
    const degradedStatus = main
      .locator('[role="alert"]:not(.mc-next-blocks-loader), [role="status"]:not(.mc-next-blocks-loader)')
      .first();
    await degradedStatus.waitFor({ state: "visible", timeout: 15_000 });
    const degradedMessage = (await degradedStatus.innerText()).trim();
    if (!degradedMessage) {
      throw new Error(`experimental route ${input.routeSlug} exposed no operator-readable outage message`);
    }
    const retry = main.getByRole("button", { name: /^retry$/iu });
    if ((await retry.count()) !== 1 || !(await retry.isVisible()) || !(await retry.isEnabled())) {
      throw new Error(`experimental route ${input.routeSlug} exposed no truthful enabled Retry action`);
    }
    const enabledMutations = await collectEnabledExperimentalMutations(main, input.routeSlug);
    if (enabledMutations.length > 0) {
      throw new Error(
        `experimental route ${input.routeSlug} left mutation controls enabled during outage: ${enabledMutations.join(", ")}`,
      );
    }
    const mainText = (await main.innerText()).trim();
    if (mainText.length === 0) throw new Error(`experimental route ${input.routeSlug} rendered an empty main surface`);
    if ((await page.locator("vite-error-overlay").count()) > 0) {
      throw new Error(`experimental route ${input.routeSlug} rendered the Vite error overlay`);
    }
    if (/\b(?:TypeError|ReferenceError|Cannot read properties of|at [A-Za-z0-9_$]+ \()\b/u.test(mainText)) {
      throw new Error(`experimental route ${input.routeSlug} exposed an implementation error under degradation`);
    }
    if (degradedApiRequests === 0) {
      throw new Error(`experimental route ${input.routeSlug} did not exercise the deterministic Gateway outage`);
    }
    const currentUrl = new URL(page.url());
    const expectedUrl = new URL(input.routeHref, currentUrl.origin);
    if (currentUrl.pathname !== expectedUrl.pathname) {
      throw new Error(
        `experimental route ${input.routeSlug} escaped its route under degradation (${currentUrl.pathname})`,
      );
    }
    return {
      degradedApiRequests,
      degradedState: "operator_visible_error",
      degradedMessage,
      degradedRole: await degradedStatus.getAttribute("role"),
      retryVisible: true,
      enabledMutations,
    };
  } finally {
    await page.unroute(apiPattern, rejectGatewayRequest);
  }
}

async function collectEnabledExperimentalMutations(main, routeSlug) {
  const patternsBySlug = {
    "library-journey": [],
    "library-curator": [/run dry-run/iu, /^archive\b/iu, /^prune\b/iu],
    "ops-improvement": [/approve/iu, /reject/iu, /apply/iu, /activate/iu],
    "ops-kanban": [/^unblock$/iu, /^retry selected/iu, /^close$/iu],
    "settings-personalities": [/save/iu, /delete/iu, /reset/iu, /make default/iu],
    // Staging a bundled local review pack does not depend on the failed add-on
    // catalog/installed-state reads. Keep that independent, reversible action
    // available while blocking mutations that require the unavailable owner.
    "settings-addons": [/install/iu, /update/iu, /disable/iu, /launch/iu, /^stop$/iu, /uninstall/iu],
  };
  const patterns = patternsBySlug[routeSlug];
  if (!patterns) throw new Error(`no degraded mutation policy is registered for ${routeSlug}`);
  if (patterns.length === 0) return [];
  const candidates = await main.getByRole("button").all();
  const enabled = [];
  for (const candidate of candidates) {
    if (!(await candidate.isVisible()) || !(await candidate.isEnabled())) continue;
    const name = (await candidate.innerText()).trim().replace(/\s+/gu, " ");
    if (name && patterns.some((pattern) => pattern.test(name))) enabled.push(name);
  }
  return enabled;
}

function experimentalDegradedApiPath(routeSlug) {
  const targetBySlug = {
    "library-journey": "/api/v1/journey/",
    "library-curator": "/api/v1/curator/",
    "ops-improvement": "/api/v1/observe/timeline",
    "ops-kanban": "/api/v1/agentic/runs",
    "settings-personalities": "/api/v1/personalities",
    "settings-addons": "/api/v1/addons/",
  };
  const target = targetBySlug[routeSlug];
  if (!target) throw new Error(`no deterministic degraded API target is registered for ${routeSlug}`);
  return target;
}

export async function navigateSurfaceRoute(page, url, options = {}) {
  const allowInitialColdStartRecovery = options.allowInitialColdStartRecovery === true;
  const maxAttempts = allowInitialColdStartRecovery ? INITIAL_ROUTE_NAVIGATION_MAX_ATTEMPTS : 1;
  let recoveryReason = null;

  for (let attempts = 1; attempts <= maxAttempts; attempts += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      return {
        attempts,
        recoveryReason,
        recoveryDisposition: attempts > 1 ? "retried" : "not_needed",
      };
    } catch (error) {
      const canRecover = allowInitialColdStartRecovery && attempts === 1 && isNavigationTimeoutError(error);
      if (!canRecover) {
        throw new SurfaceNavigationFailure(error, {
          attempts,
          recoveryReason,
          recoveryDisposition: attempts > 1 ? "retry_exhausted" : "failed_without_retry",
        });
      }

      recoveryReason = INITIAL_ROUTE_TIMEOUT_REASON;
      try {
        await page.waitForLoadState("domcontentloaded", {
          timeout: INITIAL_ROUTE_READINESS_GRACE_MS,
        });
        return {
          attempts,
          recoveryReason,
          recoveryDisposition: "completed_during_readiness_grace",
        };
      } catch (readinessError) {
        if (!isNavigationTimeoutError(readinessError)) {
          throw new SurfaceNavigationFailure(readinessError, {
            attempts,
            recoveryReason,
            recoveryDisposition: "readiness_failed",
          });
        }
      }
    }
  }

  throw new Error("surface navigation attempt accounting exhausted unexpectedly");
}

class SurfaceNavigationFailure extends Error {
  constructor(cause, navigationEvidence) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = cause instanceof Error ? cause.name : "SurfaceNavigationFailure";
    this.navigationEvidence = navigationEvidence;
    if (cause instanceof Error && cause.stack) {
      this.stack = cause.stack;
    }
  }
}

function emptyNavigationEvidence() {
  return {
    attempts: 0,
    recoveryReason: null,
    recoveryDisposition: "not_started",
  };
}

function navigationEvidenceFromError(error) {
  return error instanceof SurfaceNavigationFailure ? error.navigationEvidence : null;
}

function isNavigationTimeoutError(error) {
  return error instanceof Error && (error.name === "TimeoutError" || /Timeout \d+ms exceeded/iu.test(error.message));
}

function formatBrowserFailure(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function mergeArtifactSets(left, right) {
  const merged = {};
  for (const key of ["diagnostics", "screenshots", "traces", "logs", "perf", "playwright"]) {
    merged[key] = [...new Set([...(left?.[key] ?? []), ...(right?.[key] ?? [])])];
  }
  return merged;
}
