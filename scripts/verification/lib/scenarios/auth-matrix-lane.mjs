export async function runAuthMatrixLane(context, _options = {}, deps) {
  const {
    assertApprovalIngressMatrix,
    assertHighRiskRouteFamiliesAreOperatorGated,
    assertOk,
    buildAuthMatrixExpectations,
    clampString,
    createAuthMatrixCredentials,
    emptyArtifacts,
    ensureOnboardingComplete,
    isAllowedStatus,
    issueOperatorSseToken,
    path,
    probeAuthMatrixRoute,
    relativeToRun,
    requestJson,
    runScenario,
    selectRepresentativeManifestRoute,
    startVerificationStack,
    stopVerificationStack,
    writeJson,
  } = deps;
  const operatorToken = "verification-auth-matrix-token";
  const approvalCreateToken = "verification-approval-create-token";
  const operatorHeaders = {
    Authorization: `Bearer ${operatorToken}`,
  };
  const stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: operatorToken,
      GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN: approvalCreateToken,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
    },
  });
  try {
    await ensureOnboardingComplete(stack.gatewayUrl, "verification-auth-matrix", operatorHeaders);
    await runScenario(
      context,
      {
        id: "auth-matrix.route-access-principals",
        lane: "auth-matrix",
        title: "Tracked route-access classes enforce the expected principal matrix",
        subsystem: "gateway",
      },
      async () => {
        const manifestResponse = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/route-access-manifest", {
          headers: operatorHeaders,
        });
        assertOk(manifestResponse, "fetch route-access manifest");

        const deviceAndCompanion = await createAuthMatrixCredentials(stack.gatewayUrl, operatorHeaders);
        const sseToken = await issueOperatorSseToken(stack.gatewayUrl, operatorHeaders);
        // Session-scoped representatives (…/:sessionId/…) need a real session so
        // the allowed caller can reach 2xx instead of a not-found error.
        const seeded = await requestJson(stack.gatewayUrl, "/api/v1/dev/verification/seed", {
          method: "POST",
          headers: operatorHeaders,
          body: {
            workspaceName: "Auth Matrix Verification Workspace",
            sessionTitle: "Auth Matrix Verification Session",
            sessionCount: 1,
            longThreadTurns: 2,
          },
        });
        assertOk(seeded, "seed auth-matrix session fixture");
        const seededSessionId = seeded.body?.sessionId;
        if (!seededSessionId) {
          throw new Error(
            `auth-matrix seed response missing sessionId: ${clampString(JSON.stringify(seeded.body), 400)}`,
          );
        }
        const manifestItems = Array.isArray(manifestResponse.body?.items) ? manifestResponse.body.items : [];
        const missingTracked = Array.isArray(manifestResponse.body?.missingTracked)
          ? manifestResponse.body.missingTracked
          : [];
        if (missingTracked.length > 0) {
          throw new Error(
            `auth-matrix route-access manifest has unclassified tracked routes: ${clampString(JSON.stringify(missingTracked), 800)}`,
          );
        }
        const accessClasses = [...new Set(manifestItems.map((item) => item.accessClass).filter(Boolean))];
        const results = [];
        const skippedAccessClasses = [];

        for (const accessClass of accessClasses) {
          const representative = selectRepresentativeManifestRoute(manifestItems, accessClass);
          if (!representative) {
            if (accessClass === "webhook") {
              skippedAccessClasses.push(accessClass);
              continue;
            }
            throw new Error(`auth-matrix could not find a representative route for ${accessClass}`);
          }
          const expectations = buildAuthMatrixExpectations(accessClass);
          for (const [caller, expected] of Object.entries(expectations)) {
            const probe = await probeAuthMatrixRoute(stack.gatewayUrl, representative, {
              caller,
              operatorHeaders,
              deviceToken: deviceAndCompanion.deviceToken,
              companionToken: deviceAndCompanion.companionToken,
              companionPrivateKey: deviceAndCompanion.companionPrivateKey,
              companionPublicKey: deviceAndCompanion.companionPublicKey,
              sseToken,
              seededSessionId,
            });
            const allowed = isAllowedStatus(probe.status);
            if (allowed !== expected) {
              throw new Error(
                `auth-matrix ${accessClass} expected ${caller} to be ${expected ? "allowed" : "denied"} on ${representative.method} ${representative.url}, got ${probe.status} with ${clampString(JSON.stringify(probe.body ?? probe.preview ?? null), 400)}`,
              );
            }
            results.push({
              accessClass,
              caller,
              method: representative.method,
              url: representative.url,
              status: probe.status,
              allowed,
            });
          }
        }

        await assertHighRiskRouteFamiliesAreOperatorGated(stack.gatewayUrl, manifestItems, {
          operatorHeaders,
          deviceToken: deviceAndCompanion.deviceToken,
          companionToken: deviceAndCompanion.companionToken,
        });
        const approvalIngressResults = await assertApprovalIngressMatrix(
          stack.gatewayUrl,
          approvalCreateToken,
          operatorHeaders,
        );

        const outPath = path.join(context.artifactRoot, "diagnostics", "auth-matrix-route-access.json");
        await writeJson(outPath, {
          manifest: manifestResponse.body,
          results,
          approvalIngressResults,
          skippedAccessClasses,
        });
        return {
          status: "passed",
          metrics: {
            representedAccessClasses: accessClasses.length,
            skippedAccessClasses: skippedAccessClasses.length,
            checks: results.length,
          },
          artifacts: emptyArtifacts({
            diagnostics: [relativeToRun(context, outPath)],
          }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }
}
