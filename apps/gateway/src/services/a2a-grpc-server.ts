import type { FastifyBaseLogger } from "fastify";
import type { GatewayRuntimeConfig } from "../config.js";
import { isLoopbackHost } from "../startup-guard.js";
import type { A2ARouteService } from "./a2a-route-service.js";
import type { SharedHostLifecycleAdmissionPort } from "./shared-host-lifecycle-service.js";

export interface A2AGrpcServerHandle {
  enabled: boolean;
  address?: string;
  close: () => Promise<void>;
}

export interface StartA2AGrpcServerInput {
  config: GatewayRuntimeConfig;
  a2a: A2ARouteService;
  sharedHostLifecycle?: SharedHostLifecycleAdmissionPort;
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
}

export async function startA2AGrpcServer(input: StartA2AGrpcServerInput): Promise<A2AGrpcServerHandle> {
  const a2a = input.config.assistant.a2a;
  if (!a2a.enabled || !a2a.inbound.enabled || !a2a.bindings.includes("GRPC") || !a2a.inbound.grpc.enabled) {
    return {
      enabled: false,
      close: async () => undefined,
    };
  }

  const { host, port } = a2a.inbound.grpc;
  if (!isLoopbackHost(host)) {
    throw new Error("The A2A gRPC listener requires a loopback bind. Use a TLS proxy for remote access.");
  }
  const { startA2AGrpcListener } = await import("./a2a-grpc-listener.js");
  return startA2AGrpcListener(input, { host, port });
}
