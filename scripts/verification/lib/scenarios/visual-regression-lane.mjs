export async function runVisualRegressionLane(context, options = {}, deps) {
  const {
    VISUAL_DIFF_RATIO_THRESHOLD,
    VISUAL_ROUTE_READY_TIMEOUT_MS,
    appendTraceArtifact,
    assertBrowserConsoleHealthy,
    assertNextVisualScenarioChrome,
    assertNoFooterStatusCollision,
    assertVisualBaselineCoverage,
    attachBrowserLogging,
    buildVerificationUiUrl,
    captureBrowserArtifacts,
    captureRouteReadyFailure,
    chromium,
    compareVisualBaseline,
    ensureOnboardingComplete,
    filterVisualItemsBySlug,
    installMissionControlNextBrowserState,
    maybeParseBool,
    pinVisualRegressionProvider,
    resolveVerificationTargetContext,
    resolveVisualRouteHref,
    runScenario,
    seedMissionControlNextFixture,
    setBrowserCorrelation,
    stabilizeVisualRegressionSnapshot,
    startBrowserTrace,
    startVerificationStack,
    stopVerificationStack,
    waitForVerificationRouteReady,
    writeMissionControlNextManualProofChecklist,
  } = deps;
  const verificationTarget = resolveVerificationTargetContext();
  const visualOperatorToken = "verification-visual-regression-operator-token";
  const updateBaselines = maybeParseBool(options.updateBaselines, false);
  const scenarioLane = updateBaselines ? "visual-rebaseline" : "visual-regression";
  const scenarioTitleSuffix = updateBaselines ? "baseline refresh" : "baseline renders";
  const visualRoutes = filterVisualItemsBySlug(
    verificationTarget.visualRoutes,
    process.env.GOATCITADEL_VERIFY_VISUAL_ROUTE_SLUGS,
    "visual route",
  );
  const visualVariants = filterVisualItemsBySlug(
    verificationTarget.visualVariants,
    process.env.GOATCITADEL_VERIFY_VISUAL_VARIANT_SLUGS,
    "visual variant",
  );
  if (!updateBaselines) {
    await assertVisualBaselineCoverage(context, { packageName: verificationTarget.packageName });
  }
  const stack = await startVerificationStack(context, {
    includeUi: true,
    gatewayMode: "built",
    uiMode: "preview",
    gatewayEnv: {
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: visualOperatorToken,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "true",
      GOATCITADEL_FEATURE_CODE_MODE_V1_ENABLED: "true",
      GOATCITADEL_CODE_MODE_SANDBOX_REQUIRED: "false",
      GOATCITADEL_DISABLE_MAINTENANCE_SCHEDULER: "true",
      GOATCITADEL_MESH_NODE_ID: "build-main",
      OPENAI_API_KEY: "sk-visual-regression",
    },
    uiEnv: {
      VITE_GOATCITADEL_VISUAL_REGRESSION_MODE: "true",
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-visual-regression");
    await pinVisualRegressionProvider(stack.gatewayUrl);
    const fixture = verificationTarget.isNext
      ? await seedMissionControlNextFixture(stack.gatewayUrl, { runtimeRoot: stack.runtimeRoot })
      : null;
    const manualProofArtifacts = [];
    const browser = await chromium.launch({ headless: true });
    try {
      for (const variant of visualVariants) {
        const browserContext = await browser.newContext({
          viewport: variant.viewport,
          colorScheme: variant.colorScheme,
          timezoneId: "UTC",
        });
        if (fixture && verificationTarget.isNext) {
          await installMissionControlNextBrowserState(browserContext, fixture.workspaceId, fixture.citadelId);
        }
        try {
          const page = await browserContext.newPage();
          const browserLog = attachBrowserLogging(page);
          for (const route of visualRoutes) {
            const scenarioRecord = await runScenario(
              context,
              {
                id: `${scenarioLane}.${route.slug}.${variant.slug}`,
                lane: scenarioLane,
                title: `${route.slug} ${variant.slug} ${scenarioTitleSuffix}`,
                subsystem: "mission-control",
              },
              async ({ correlationId }) => {
                const browserLogCursor = browserLog.mark();
                const baselineSlug = `visual-regression-${route.slug}-${variant.slug}`;
                const artifactSlug = `${scenarioLane}-${route.slug}-${variant.slug}`;
                const trace = await startBrowserTrace(context, { page, slug: artifactSlug });
                let artifacts;
                try {
                  await page.goto(
                    buildVerificationUiUrl(stack.uiUrl, resolveVisualRouteHref(route, variant, fixture)),
                    {
                      waitUntil: "domcontentloaded",
                    },
                  );
                  try {
                    await waitForVerificationRouteReady(
                      page,
                      route,
                      verificationTarget.packageName,
                      VISUAL_ROUTE_READY_TIMEOUT_MS,
                    );
                    await assertNextVisualScenarioChrome(page, route);
                  } catch (readyError) {
                    const readyFailure = await captureRouteReadyFailure(context, {
                      page,
                      browserLog,
                      browserLogCursor,
                      route,
                      variant,
                      scenarioLane,
                      timeoutMs: VISUAL_ROUTE_READY_TIMEOUT_MS,
                      readyError,
                    });
                    const traceArtifact = await trace.retain().catch(() => null);
                    return {
                      ...readyFailure,
                      artifacts: appendTraceArtifact(readyFailure.artifacts, traceArtifact),
                    };
                  }
                  const correlationSessionId =
                    (route?.fixtureSessionKey && fixture?.sessions?.[route.fixtureSessionKey]) || fixture?.sessionId;
                  await setBrowserCorrelation(page, correlationId, correlationSessionId);
                  const browserSanity = assertBrowserConsoleHealthy(
                    browserLog,
                    browserLogCursor,
                    verificationTarget.packageName,
                  );
                  await page.evaluate(async () => {
                    if (document.fonts?.ready) {
                      await document.fonts.ready;
                    }
                  });
                  await page.waitForTimeout(1000);
                  await stabilizeVisualRegressionSnapshot(page);
                  await assertMobileVisualGeometry(page, route, variant);
                  await assertNoFooterStatusCollision(page, { route, variant });
                  artifacts = await captureBrowserArtifacts(context, {
                    slug: artifactSlug,
                    page,
                    browserLog,
                    gatewayUrl: stack.gatewayUrl,
                    correlationId,
                    logCursor: browserLogCursor,
                  });
                  const comparison = await compareVisualBaseline(context, baselineSlug, {
                    artifactSlug,
                    updateBaselines,
                    packageName: verificationTarget.packageName,
                  });
                  const failed = comparison.diffRatio > VISUAL_DIFF_RATIO_THRESHOLD;
                  const comparisonArtifacts = {
                    ...artifacts,
                    screenshots: [...artifacts.screenshots, ...comparison.screenshots],
                    diagnostics: [...artifacts.diagnostics, ...comparison.diagnostics],
                  };
                  const traceArtifact = failed ? await trace.retain().catch(() => null) : null;
                  return {
                    status: failed ? "failed" : "passed",
                    error: failed
                      ? `visual diff ratio ${comparison.diffRatio.toFixed(4)} exceeded threshold ${VISUAL_DIFF_RATIO_THRESHOLD}`
                      : undefined,
                    metrics: {
                      route: route.href,
                      variant: variant.slug,
                      diffRatio: comparison.diffRatio,
                      changedPixels: comparison.changedPixels,
                      consoleErrors: browserSanity.consoleErrors.length,
                      pageErrors: browserSanity.pageErrors.length,
                    },
                    artifacts: appendTraceArtifact(comparisonArtifacts, traceArtifact),
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
                    metrics: { route: route.href, variant: variant.slug },
                    artifacts: appendTraceArtifact(artifacts, traceArtifact),
                  };
                } finally {
                  await trace.discard().catch(() => undefined);
                }
              },
            );
            if (verificationTarget.isNext && scenarioRecord?.artifacts?.screenshots?.length) {
              manualProofArtifacts.push({
                routeSlug: route.slug,
                variantSlug: variant.slug,
                screenshots: scenarioRecord.artifacts.screenshots,
              });
            }
          }
        } finally {
          await browserContext.close();
        }
      }
    } finally {
      await browser.close();
    }

    if (verificationTarget.isNext) {
      await writeMissionControlNextManualProofChecklist(context, manualProofArtifacts);
    }
  } finally {
    await stopVerificationStack(stack);
  }
}

export async function assertMobileVisualGeometry(page, route, variant) {
  if (!variant?.viewport || variant.viewport.width > 840) {
    return;
  }
  const pendingInputSelectors =
    route?.slug === "chat-pending-user-input"
      ? [
          '.mc-next-composer-blocking-prompt[data-blocker-kind="user-input"] .chat-user-input-card',
          ".mc-next-composer-blocked-actions",
          ".mc-next-composer-primary",
        ]
      : [];
  const geometry = await page.evaluate((selectors) => {
    const viewportWidth = window.innerWidth;
    const doc = document.documentElement;
    const body = document.body;
    return {
      viewportWidth,
      documentOverflow: doc ? doc.scrollWidth - viewportWidth : 0,
      bodyOverflow: body ? body.scrollWidth - viewportWidth : 0,
      targets: selectors.map((selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          return { selector, missing: true };
        }
        const rect = element.getBoundingClientRect();
        const ancestors = [];
        let ancestor = element;
        while (ancestor instanceof HTMLElement && ancestors.length < 8) {
          const ancestorRect = ancestor.getBoundingClientRect();
          const style = window.getComputedStyle(ancestor);
          ancestors.push({
            node: `${ancestor.tagName.toLowerCase()}${ancestor.className ? `.${String(ancestor.className).trim().replace(/\s+/g, ".")}` : ""}`,
            left: ancestorRect.left,
            right: ancestorRect.right,
            width: ancestorRect.width,
            boxSizing: style.boxSizing,
            minWidth: style.minWidth,
            paddingInline: `${style.paddingInlineStart}/${style.paddingInlineEnd}`,
          });
          ancestor = ancestor.parentElement;
        }
        return {
          selector,
          missing: false,
          left: rect.left,
          right: rect.right,
          width: rect.width,
          ancestors,
        };
      }),
    };
  }, pendingInputSelectors);
  if (geometry.documentOverflow > 1 || geometry.bodyOverflow > 1) {
    throw new Error(
      `${route.slug} ${variant.slug} overflowed horizontally (document=${geometry.documentOverflow}, body=${geometry.bodyOverflow})`,
    );
  }
  for (const target of geometry.targets) {
    if (target.missing) {
      throw new Error(`${route.slug} ${variant.slug} did not render required mobile geometry target ${target.selector}`);
    }
    if (target.width <= 0 || target.left < -1 || target.right > geometry.viewportWidth + 1) {
      throw new Error(
        `${route.slug} ${variant.slug} clipped ${target.selector} horizontally (left=${target.left}, right=${target.right}, viewport=${geometry.viewportWidth}, ancestors=${JSON.stringify(target.ancestors)})`,
      );
    }
  }
}

function formatBrowserFailure(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
