export async function runSurfaceRegressionLane(context, options = {}, deps) {
  const {
    assertBrowserConsoleHealthy,
    assertLegacyRedirectResolution,
    attachBrowserLogging,
    buildVerificationUiUrl,
    captureBrowserArtifacts,
    chromium,
    ensureOnboardingComplete,
    installMissionControlNextBrowserState,
    performVerificationInteraction,
    resolveVerificationTargetContext,
    runMissionControlNextMobileShellProof,
    runScenario,
    seedMissionControlNextFixture,
    setBrowserCorrelation,
    startVerificationStack,
    stopVerificationStack,
    waitForMissionControlShell,
    waitForVerificationRouteReady,
  } = deps;
  const verificationTarget = resolveVerificationTargetContext();
  const stack = await startVerificationStack(context, {
    includeUi: true,
    gatewayEnv: {
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

      for (const route of verificationTarget.surfaceRoutes) {
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
            await page.goto(buildVerificationUiUrl(stack.uiUrl, route.href), { waitUntil: "domcontentloaded" });
            await waitForVerificationRouteReady(page, route, verificationTarget.packageName);
            await setBrowserCorrelation(page, correlationId, fixture?.sessionId);
            await performVerificationInteraction(page, route.interaction, verificationTarget.packageName);
            const browserSanity = assertBrowserConsoleHealthy(
              browserLog,
              browserLogCursor,
              verificationTarget.packageName,
            );
            await page.waitForTimeout(250);
            const artifacts = await captureBrowserArtifacts(context, {
              slug: `surface-regression-${route.slug}`,
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
              },
              artifacts,
            };
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
            const artifacts = await captureBrowserArtifacts(context, {
              slug: `surface-regression-redirect-${redirect.slug}`,
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
