export async function runApiCompatibilityLane(context, _options = {}, deps) {
  const {
    API_COMPAT_ALLOWLIST_PATH,
    API_COMPAT_BASELINE_PATH,
    assertOk,
    compareRealtimeContract,
    compareRestContract,
    emptyArtifacts,
    path,
    readJson,
    relativeToRun,
    requestJson,
    runScenario,
    snapshotApiCompatibilityCurrentShellFacts,
    snapshotRealtimeContract,
    snapshotRestContract,
    startVerificationStack,
    stopVerificationStack,
    VERIFICATION_OPERATOR_AUTH_ENV,
    writeJson,
  } = deps;
  const stack = await startVerificationStack(context, {
    includeUi: false,
    // Snapshotting the shell facts seeds the Mission Control Next fixture, which
    // creates an operator-authenticated Ops saved board.
    gatewayEnv: { ...VERIFICATION_OPERATOR_AUTH_ENV },
  });
  try {
    await runScenario(
      context,
      {
        id: "api-compat.rest-sse.additive-only",
        lane: "api-compat",
        title: "REST routes and SSE envelopes remain additive-only against the checked-in baseline",
        subsystem: "contracts",
      },
      async () => {
        const openApi = await requestJson(stack.gatewayUrl, "/api/v1/docs/openapi.json");
        assertOk(openApi, "fetch openapi spec for compatibility lane");
        const current = {
          rest: snapshotRestContract(openApi.body),
          sse: await snapshotRealtimeContract(),
        };
        const currentShellFacts = await snapshotApiCompatibilityCurrentShellFacts(stack.gatewayUrl);
        const baseline = await readJson(API_COMPAT_BASELINE_PATH);
        const allowlist = await readJson(API_COMPAT_ALLOWLIST_PATH).catch(() => ({
          removedRestPaths: [],
          removedRestMethods: [],
          removedRestResponses: [],
          removedSseEventTypes: [],
          removedSseEnvelopeFields: [],
        }));
        const issues = [
          ...compareRestContract(baseline.rest ?? {}, current.rest, allowlist),
          ...compareRealtimeContract(baseline.sse ?? {}, current.sse, allowlist),
        ];
        const artifactPath = path.join(context.artifactRoot, "diagnostics", "api-compat-rest-sse.json");
        await writeJson(artifactPath, {
          checkedAt: new Date().toISOString(),
          baselinePath: API_COMPAT_BASELINE_PATH,
          allowlistPath: API_COMPAT_ALLOWLIST_PATH,
          current,
          currentShellFacts,
          issues,
        });
        return {
          status: issues.length > 0 ? "failed" : "passed",
          error: issues.length > 0 ? issues.join("\n") : undefined,
          metrics: {
            restPathCount: Object.keys(current.rest).length,
            sseEventTypeCount: current.sse.eventTypes.length,
            sseEnvelopeFieldCount: current.sse.envelopeFields.length,
            currentShellFactCount: Object.keys(currentShellFacts.routes).length,
          },
          artifacts: emptyArtifacts({
            diagnostics: [relativeToRun(context, artifactPath)],
          }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }

}
