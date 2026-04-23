import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot } from "./shared.mjs";

const ARCHITECTURE_BASELINE_PATH = path.join(repoRoot, "scripts", "verification", "baselines", "architecture-metrics.json");

export async function collectArchitectureMetrics(rootDir = repoRoot) {
  const routesDir = path.join(rootDir, "apps", "gateway", "src", "routes");
  const servicesDir = path.join(rootDir, "apps", "gateway", "src", "services");
  const gatewayServicePath = path.join(servicesDir, "gateway-service.ts");

  const routeFiles = await listFiles(routesDir, (filePath) => filePath.endsWith(".ts"));
  const serviceFiles = await listFiles(
    servicesDir,
    (filePath) => filePath.endsWith(".ts") && !filePath.endsWith(".test.ts"),
  );
  const routeFacingServiceFiles = serviceFiles.filter((filePath) => filePath.endsWith("-route-service.ts"));

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

  const fastifyGatewayCallSites = await countPatternAcrossFiles(routeFiles, /fastify\.gateway\./g);
  const gatewayInternalPublicCount = await countPatternAcrossFiles(
    [gatewayServicePath],
    /\/\*\* @internal \*\/ public/g,
  );

  return {
    generatedAt: new Date().toISOString(),
    fastifyGatewayCallSites,
    gatewayInternalPublicCount,
    totalHostCallbacks,
    hostCallbacksByFile,
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
    fastifyGatewayCallSites: metrics.fastifyGatewayCallSites - baseline.fastifyGatewayCallSites,
    gatewayInternalPublicCount: metrics.gatewayInternalPublicCount - baseline.gatewayInternalPublicCount,
    totalHostCallbacks: metrics.totalHostCallbacks - baseline.totalHostCallbacks,
    routeFacingServiceCount: metrics.routeFacingServiceCount - baseline.routeFacingServiceCount,
  };

  if (metrics.fastifyGatewayCallSites > baseline.fastifyGatewayCallSites) {
    regressions.push(
      `fastify.gateway.* call sites increased from ${baseline.fastifyGatewayCallSites} to ${metrics.fastifyGatewayCallSites}`,
    );
  } else if (metrics.fastifyGatewayCallSites < baseline.fastifyGatewayCallSites) {
    improvements.push(
      `fastify.gateway.* call sites decreased from ${baseline.fastifyGatewayCallSites} to ${metrics.fastifyGatewayCallSites}`,
    );
  }

  if (metrics.gatewayInternalPublicCount > baseline.gatewayInternalPublicCount) {
    regressions.push(
      `GatewayService @internal public count increased from ${baseline.gatewayInternalPublicCount} to ${metrics.gatewayInternalPublicCount}`,
    );
  } else if (metrics.gatewayInternalPublicCount < baseline.gatewayInternalPublicCount) {
    improvements.push(
      `GatewayService @internal public count decreased from ${baseline.gatewayInternalPublicCount} to ${metrics.gatewayInternalPublicCount}`,
    );
  }

  if (metrics.totalHostCallbacks > baseline.totalHostCallbacks) {
    regressions.push(
      `Extracted-service host.* callbacks increased from ${baseline.totalHostCallbacks} to ${metrics.totalHostCallbacks}`,
    );
  } else if (metrics.totalHostCallbacks < baseline.totalHostCallbacks) {
    improvements.push(
      `Extracted-service host.* callbacks decreased from ${baseline.totalHostCallbacks} to ${metrics.totalHostCallbacks}`,
    );
  }

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

function countMatches(content, pattern) {
  const matches = content.match(pattern);
  return Array.isArray(matches) ? matches.length : 0;
}
