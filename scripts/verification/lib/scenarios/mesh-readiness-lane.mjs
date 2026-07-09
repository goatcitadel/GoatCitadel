export async function runMeshReadinessLane(context, _options = {}, deps) {
  const {
    assertOk,
    emptyArtifacts,
    path,
    randomUUID,
    relativeToRun,
    requestJson,
    runScenario,
    startVerificationStack,
    stopVerificationStack,
    writeJson,
  } = deps;

  const joinToken = `verify-mesh-${context.runId}`;
  const stack = await startVerificationStack(context, {
    includeUi: false,
    gatewayEnv: {
      GOATCITADEL_MESH_ENABLED: "true",
      GOATCITADEL_MESH_JOIN_TOKEN: joinToken,
      GOATCITADEL_DISABLE_SECRET_STORE: "true",
    },
  });
  try {
    await runScenario(
      context,
      {
        id: "mesh.readiness.gateway-route-proof",
        lane: "mesh-readiness",
        title: "Mesh readiness route covers join, lease, owner, replication, and diagnostics posture",
        subsystem: "mesh-core",
      },
      async () => {
        const nodeId = `verify-node-${randomUUID()}`;
        const leaseKey = `verify-lease-${randomUUID()}`;
        const sessionId = `verify-session-${randomUUID()}`;
        const initialReadiness = await requestJson(stack.gatewayUrl, "/api/v1/mesh/readiness");
        assertOk(initialReadiness, "mesh readiness before route exercise");
        const join = await requestJson(stack.gatewayUrl, "/api/v1/mesh/join", {
          method: "POST",
          body: {
            token: joinToken,
            nodeId,
            label: "Verification mesh node",
            transport: "lan",
            capabilities: ["verification"],
            tlsFingerprint: `sha256:${randomUUID().replaceAll("-", "")}`,
          },
        });
        assertOk(join, "mesh join");
        const acquired = await requestJson(stack.gatewayUrl, "/api/v1/mesh/leases/acquire", {
          method: "POST",
          body: { leaseKey, holderNodeId: nodeId, ttlSeconds: 60 },
        });
        assertOk(acquired, "mesh lease acquire");
        const renewed = await requestJson(stack.gatewayUrl, "/api/v1/mesh/leases/renew", {
          method: "POST",
          body: {
            leaseKey,
            holderNodeId: nodeId,
            fencingToken: acquired.body?.fencingToken,
            ttlSeconds: 60,
          },
        });
        assertOk(renewed, "mesh lease renew");
        const owner = await requestJson(stack.gatewayUrl, `/api/v1/mesh/sessions/${encodeURIComponent(sessionId)}/claim`, {
          method: "POST",
          body: { ownerNodeId: nodeId },
        });
        assertOk(owner, "mesh session owner claim");
        const takeover = await requestJson(stack.gatewayUrl, `/api/v1/mesh/sessions/${encodeURIComponent(sessionId)}/claim`, {
          method: "POST",
          body: { ownerNodeId: nodeId, expectedEpoch: owner.body?.epoch, force: true },
        });
        assertOk(takeover, "mesh session owner takeover");
        const replication = await requestJson(stack.gatewayUrl, "/api/v1/mesh/replication/events", {
          method: "POST",
          body: {
            sourceNodeId: nodeId,
            eventType: "verification.mesh.readiness",
            payload: { ok: true },
            idempotencyKey: `verify-${randomUUID()}`,
          },
        });
        assertOk(replication, "mesh replication event");
        const released = await requestJson(stack.gatewayUrl, "/api/v1/mesh/leases/release", {
          method: "POST",
          body: {
            leaseKey,
            holderNodeId: nodeId,
            fencingToken: renewed.body?.fencingToken,
          },
        });
        assertOk(released, "mesh lease release");
        const finalReadiness = await requestJson(stack.gatewayUrl, "/api/v1/mesh/readiness");
        assertOk(finalReadiness, "mesh readiness after route exercise");
        const diagnosticsPath = path.join(context.artifactRoot, "diagnostics", "mesh-readiness.json");
        await writeJson(diagnosticsPath, {
          checkedAt: new Date().toISOString(),
          initialReadiness: initialReadiness.body,
          finalReadiness: finalReadiness.body,
          join: join.body,
          acquired: acquired.body,
          renewed: renewed.body,
          owner: owner.body,
          takeover: takeover.body,
          replication: replication.body,
          released: released.body,
        });
        return {
          status: finalReadiness.body?.status === "ready" ? "passed" : "failed",
          error:
            finalReadiness.body?.status === "ready"
              ? undefined
              : `Mesh readiness status is ${finalReadiness.body?.status}: ${(finalReadiness.body?.blockers ?? []).join("; ")}`,
          metrics: {
            readinessStatus: finalReadiness.body?.status,
            checks: Array.isArray(finalReadiness.body?.checks) ? finalReadiness.body.checks.length : 0,
            blockers: Array.isArray(finalReadiness.body?.blockers) ? finalReadiness.body.blockers.length : 0,
          },
          artifacts: emptyArtifacts({
            diagnostics: [relativeToRun(context, diagnosticsPath)],
          }),
        };
      },
    );
  } finally {
    await stopVerificationStack(stack);
  }
}
