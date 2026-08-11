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
    restartGatewayProcess,
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
  const basicUsername = "verification-basic-operator";
  const basicPassword = "verification-basic-password";
  const basicHeaders = {
    Authorization: `Basic ${Buffer.from(`${basicUsername}:${basicPassword}`, "utf8").toString("base64")}`,
  };
  const basicGatewayEnv = {
    GOATCITADEL_AUTH_MODE: "basic",
    GOATCITADEL_AUTH_BASIC_USERNAME: basicUsername,
    GOATCITADEL_AUTH_BASIC_PASSWORD: basicPassword,
    GOATCITADEL_REMOTE_APPROVAL_CREATE_TOKEN: approvalCreateToken,
    GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
  };
  let deviceAndCompanion;
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

        deviceAndCompanion = await createAuthMatrixCredentials(stack.gatewayUrl, operatorHeaders);
        const sseToken = await issueOperatorSseToken(stack.gatewayUrl, operatorHeaders);
        // Session-scoped representatives (…/:sessionId/…) need a real session so
        // the allowed caller can reach 2xx instead of a not-found error; the
        // workspace-scoped loopback representative reuses the seeded workspace
        // id the same way.
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
        const seededWorkspaceId = seeded.body?.workspaceId;
        if (!seededSessionId || !seededWorkspaceId) {
          throw new Error(
            `auth-matrix seed response missing sessionId or workspaceId: ${clampString(JSON.stringify(seeded.body), 400)}`,
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
              seededWorkspaceId,
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

    await runScenario(
      context,
      {
        id: "auth-matrix.basic-restart-device-revocation",
        lane: "auth-matrix",
        title: "Basic operator access and device revocation persist across owned Gateway restarts",
        subsystem: "gateway",
      },
      async () => {
        if (!deviceAndCompanion?.deviceToken) {
          throw new Error("auth-matrix route scenario did not publish an approved device credential");
        }

        const activeBeforeRestart = await requestJson(stack.gatewayUrl, "/api/v1/events?limit=1", {
          headers: { Authorization: `Bearer ${deviceAndCompanion.deviceToken}` },
        });
        assertOk(activeBeforeRestart, "read authenticated events with active device before restart");
        const gatewayPidToken = stack.gateway?.child?.pid;

        stack.gateway = await restartGatewayProcess(context, stack, basicGatewayEnv);
        const gatewayPidBasic = stack.gateway?.child?.pid;
        assertDistinctOwnedRestart(gatewayPidToken, gatewayPidBasic, "token-to-basic");

        const basicOperator = await requestJson(stack.gatewayUrl, "/api/v1/admin/retention", {
          headers: basicHeaders,
        });
        assertOk(basicOperator, "read operator route with Basic credentials after restart");
        const staleToken = await requestJson(stack.gatewayUrl, "/api/v1/admin/retention", {
          headers: operatorHeaders,
        });
        if (staleToken.status !== 401) {
          throw new Error(`token from the prior auth mode was not rejected after Basic restart (${staleToken.status})`);
        }
        const persistedDevice = await requestJson(stack.gatewayUrl, "/api/v1/events?limit=1", {
          headers: { Authorization: `Bearer ${deviceAndCompanion.deviceToken}` },
        });
        assertOk(persistedDevice, "read authenticated events with persisted device after Basic restart");

        const grants = await requestJson(stack.gatewayUrl, "/api/v1/auth/devices?view=all", {
          headers: basicHeaders,
        });
        assertOk(grants, "list device grants with Basic operator credentials");
        const deviceGrant = Array.isArray(grants.body?.items)
          ? grants.body.items.find((item) => item?.deviceLabel === "Auth Matrix Device" && !item?.revokedAt)
          : undefined;
        if (!deviceGrant?.grantId) {
          throw new Error("persisted Auth Matrix Device grant was not visible after Basic restart");
        }
        const revoked = await requestJson(
          stack.gatewayUrl,
          `/api/v1/auth/devices/${encodeURIComponent(deviceGrant.grantId)}/revoke`,
          {
            method: "POST",
            headers: basicHeaders,
            body: {},
          },
        );
        assertOk(revoked, "revoke persisted device grant with Basic operator credentials");
        const deniedImmediately = await requestJson(stack.gatewayUrl, "/api/v1/events?limit=1", {
          headers: { Authorization: `Bearer ${deviceAndCompanion.deviceToken}` },
        });
        if (deniedImmediately.status !== 401) {
          throw new Error(`revoked device credential was not denied immediately (${deniedImmediately.status})`);
        }

        stack.gateway = await restartGatewayProcess(context, stack, basicGatewayEnv);
        const gatewayPidBasicRestarted = stack.gateway?.child?.pid;
        assertDistinctOwnedRestart(gatewayPidBasic, gatewayPidBasicRestarted, "basic-revocation-persistence");
        const basicOperatorAfterRestart = await requestJson(stack.gatewayUrl, "/api/v1/admin/retention", {
          headers: basicHeaders,
        });
        assertOk(basicOperatorAfterRestart, "read operator route with Basic credentials after second restart");
        const deniedAfterRestart = await requestJson(stack.gatewayUrl, "/api/v1/events?limit=1", {
          headers: { Authorization: `Bearer ${deviceAndCompanion.deviceToken}` },
        });
        if (deniedAfterRestart.status !== 401) {
          throw new Error(`revoked device credential did not stay denied after restart (${deniedAfterRestart.status})`);
        }

        const outPath = path.join(context.artifactRoot, "diagnostics", "auth-matrix-basic-restart.json");
        await writeJson(outPath, {
          gateway: {
            endpoint: stack.gatewayUrl,
            tokenModePid: gatewayPidToken,
            basicModePid: gatewayPidBasic,
            basicRestartedPid: gatewayPidBasicRestarted,
          },
          checks: {
            activeDeviceBeforeRestart: activeBeforeRestart.status,
            basicOperatorAfterRestart: basicOperator.status,
            staleTokenAfterModeChange: staleToken.status,
            persistedDeviceAfterRestart: persistedDevice.status,
            revokeStatus: revoked.status,
            revokedDeviceImmediately: deniedImmediately.status,
            basicOperatorAfterSecondRestart: basicOperatorAfterRestart.status,
            revokedDeviceAfterSecondRestart: deniedAfterRestart.status,
          },
          grant: {
            grantId: deviceGrant.grantId,
            deviceLabel: deviceGrant.deviceLabel,
            persistedBeforeRevoke: true,
            revokedAcrossRestart: true,
          },
        });
        return {
          status: "passed",
          metrics: {
            ownedGatewayRestarts: 2,
            basicOperatorStatus: basicOperatorAfterRestart.status,
            persistedDeviceStatus: persistedDevice.status,
            revokedDeviceStatus: deniedAfterRestart.status,
          },
          artifacts: emptyArtifacts({ diagnostics: [relativeToRun(context, outPath)] }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }
}

function assertDistinctOwnedRestart(beforePid, afterPid, label) {
  if (
    !Number.isSafeInteger(beforePid) ||
    beforePid <= 0 ||
    !Number.isSafeInteger(afterPid) ||
    afterPid <= 0 ||
    beforePid === afterPid
  ) {
    throw new Error(`auth-matrix ${label} did not replace the owned Gateway process (${beforePid} -> ${afterPid})`);
  }
}
