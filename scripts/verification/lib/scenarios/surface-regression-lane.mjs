const INITIAL_ROUTE_NAVIGATION_MAX_ATTEMPTS = 2;
const INITIAL_ROUTE_READINESS_GRACE_MS = 5_000;
const INITIAL_ROUTE_TIMEOUT_REASON = "initial_navigation_timeout";

export async function runSurfaceRegressionLane(context, _options = {}, deps) {
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
              return {
                status: "passed",
                metrics: {
                  route: route.href,
                  consoleErrors: browserSanity.consoleErrors.length,
                  pageErrors: browserSanity.pageErrors.length,
                  navigationAttempts: navigationEvidence.attempts,
                  navigationRecoveryReason: navigationEvidence.recoveryReason,
                  navigationRecoveryDisposition: navigationEvidence.recoveryDisposition,
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

      for (const redirect of verificationTarget.redirectRoutes) {
        const targetHref = redirect.targetHref ?? redirect.expectedPath;
        const route = verificationTarget.routeByHref.get(targetHref);
        if (!route) {
          throw new Error(`verification redirect target was not mapped: ${targetHref}`);
        }
        await runScenario(
          context,
          {
            id: `surface-regression.redirect.${redirect.slug}`,
            lane: "surface-regression",
            title: `${redirect.slug} redirects into Mission Control Next`,
            subsystem: "mission-control",
          },
          async ({ correlationId }) => {
            const browserLogCursor = browserLog.mark();
            const artifactSlug = `surface-regression-redirect-${redirect.slug}`;
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
                metrics: { href: redirect.href, expectedPath: redirect.expectedPath, targetHref },
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
