export async function runArchitectureMetricsLane(context, deps) {
  const {
    collectArchitectureMetrics,
    compareArchitectureMetrics,
    path,
    readArchitectureMetricsBaseline,
    relativeToRun,
    runScenario,
    writeJson,
  } = deps;

  await runScenario(
    context,
    {
      id: "architecture.metrics.snapshot",
      lane: "architecture-metrics",
      title: "Gateway coupling, route-service metrics, and large-service debt snapshot",
      subsystem: "architecture",
    },
    async () => {
      const metrics = await collectArchitectureMetrics();
      const baseline = await readArchitectureMetricsBaseline();
      const comparison = compareArchitectureMetrics(metrics, baseline);
      const outPath = path.join(context.artifactRoot, "diagnostics", "architecture-metrics.json");
      const baselinePath = path.join(context.artifactRoot, "diagnostics", "architecture-metrics-baseline.json");
      const comparePath = path.join(context.artifactRoot, "diagnostics", "architecture-metrics-compare.json");
      await writeJson(outPath, metrics);
      await writeJson(baselinePath, baseline);
      await writeJson(comparePath, comparison);
      return {
        status: comparison.status,
        notes: [...comparison.debtNotes, ...comparison.improvements, ...comparison.regressions],
        error: comparison.regressions.length > 0 ? comparison.regressions.join("; ") : undefined,
        metrics: {
          gatewayLineCount: metrics.gatewayLineCount,
          largeServiceDebt: comparison.largeServiceDebt,
          gatewayPublicMethodCount: metrics.gatewayPublicMethodCount,
          gatewayServiceImportConsumerCount: metrics.gatewayServiceImportConsumerCount,
          fastifyGatewayCallSites: metrics.fastifyGatewayCallSites,
          gatewayInternalPublicCount: metrics.gatewayInternalPublicCount,
          serviceContextConsumerCount: metrics.serviceContextConsumerCount,
          totalHostCallbacks: metrics.totalHostCallbacks,
          routeFacingServiceCount: metrics.routeFacingServiceCount,
          baselineGatewayLineCount: baseline.gatewayLineCount,
          baselineGatewayPublicMethodCount: baseline.gatewayPublicMethodCount,
          baselineGatewayServiceImportConsumerCount: baseline.gatewayServiceImportConsumerCount,
          baselineFastifyGatewayCallSites: baseline.fastifyGatewayCallSites,
          baselineGatewayInternalPublicCount: baseline.gatewayInternalPublicCount,
          baselineServiceContextConsumerCount: baseline.serviceContextConsumerCount,
          baselineTotalHostCallbacks: baseline.totalHostCallbacks,
          baselineRouteFacingServiceCount: baseline.routeFacingServiceCount,
        },
        artifacts: {
          diagnostics: [
            relativeToRun(context, outPath),
            relativeToRun(context, baselinePath),
            relativeToRun(context, comparePath),
          ],
          screenshots: [],
          traces: [],
          logs: [],
          perf: [],
          playwright: [],
        },
      };
    },
  );
}
