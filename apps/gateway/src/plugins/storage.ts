import fp from "fastify-plugin";
import path from "node:path";
import { ensureBundledPostgresRuntime } from "../bundled-postgres-runtime.js";
import { repoHasConfigMarker } from "../config-files.js";
import { loadGatewayConfig } from "../config.js";
import { GatewayService } from "../services/gateway-service.js";
import type { GatewayRuntimeConfig } from "../config.js";

declare module "fastify" {
  interface FastifyInstance {
    gateway: GatewayService;
    gatewayConfig: GatewayRuntimeConfig;
  }
}

export const gatewayPlugin = fp(async (fastify) => {
  const rootDir = detectRootDir();
  const config = await loadGatewayConfig(rootDir);
  const bundledPostgres = await ensureBundledPostgresRuntime(config);
  const gateway = new GatewayService(config);
  gateway.attachDevDiagnosticsLogger(fastify.log);
  fastify.decorate("gateway", gateway);
  fastify.decorate("gatewayConfig", config);
  await gateway.initCritical();

  fastify.addHook("onReady", async () => {
    void gateway.startDeferredInit();
  });

  fastify.addHook("onClose", async () => {
    await gateway.close();
    await bundledPostgres?.stop();
  });
});

function detectRootDir(): string {
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }

  const candidates = [process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];

  for (const candidate of candidates) {
    if (repoHasConfigMarker(candidate)) {
      return candidate;
    }
  }

  return path.resolve(process.cwd(), "../..");
}
