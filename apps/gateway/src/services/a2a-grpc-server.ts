import * as grpc from "@grpc/grpc-js";
import type { FastifyBaseLogger } from "fastify";
import type { GatewayRuntimeConfig } from "../config.js";
import type { A2APeerAuthFailure, A2APeerAuthResult, A2ARouteService } from "./a2a-route-service.js";
import { A2AJsonRpcServiceError } from "./a2a-json-rpc-error.js";
import { projectA2AExternalErrorText, projectA2AExternalValue } from "./a2a-public-projection.js";
import {
  type A2AGrpcJsonRequest,
  type A2AGrpcTaskEventsRequest,
  type A2AGrpcTaskRequest,
  loadA2AGrpcServiceDefinition,
} from "./a2a-grpc-proto.js";
import { httpJsonServiceError, readNumber, readString } from "./a2a-route-utils.js";

export interface A2AGrpcServerHandle {
  enabled: boolean;
  address?: string;
  close: () => Promise<void>;
}

export interface StartA2AGrpcServerInput {
  config: GatewayRuntimeConfig;
  a2a: A2ARouteService;
  logger?: Pick<FastifyBaseLogger, "info" | "warn" | "error">;
}

export async function startA2AGrpcServer(input: StartA2AGrpcServerInput): Promise<A2AGrpcServerHandle> {
  const grpcConfig = input.config.assistant.a2a.inbound.grpc;
  if (!shouldStartA2AGrpcServer(input.config)) {
    return {
      enabled: false,
      close: async () => undefined,
    };
  }

  const server = new grpc.Server();
  server.addService(loadA2AGrpcServiceDefinition(), createA2AGrpcHandlers(input.a2a));
  const bindAddress = `${grpcConfig.host}:${grpcConfig.port}`;
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (error, boundPort) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(boundPort);
    });
  });
  const address = `grpc://${grpcConfig.host}:${port}`;
  input.logger?.info({ address }, "A2A gRPC listener started");
  return {
    enabled: true,
    address,
    close: () =>
      new Promise((resolve) => {
        server.tryShutdown((error) => {
          if (error) {
            input.logger?.warn({ error }, "A2A gRPC graceful shutdown failed; forcing close");
            server.forceShutdown();
          }
          resolve();
        });
      }),
  };
}

function shouldStartA2AGrpcServer(config: GatewayRuntimeConfig): boolean {
  const a2a = config.assistant.a2a;
  return Boolean(a2a.enabled && a2a.inbound.enabled && a2a.bindings.includes("GRPC") && a2a.inbound.grpc.enabled);
}

function createA2AGrpcHandlers(a2a: A2ARouteService): grpc.UntypedServiceImplementation {
  return {
    sendMessage: unary(a2a, async (peer, request: A2AGrpcJsonRequest) => ({
      json: JSON.stringify(projectA2AExternalValue(await a2a.sendGrpcMessage(peer, parseJsonRequest(request)))),
    })),
    sendStreamingMessage: unary(a2a, async (peer, request: A2AGrpcJsonRequest) => {
      const result = await a2a.sendGrpcStreamingMessage(peer, parseJsonRequest(request));
      return {
        taskJson: JSON.stringify(projectA2AExternalValue(result.task)),
        eventJson: result.events.map((event) => JSON.stringify(projectA2AExternalValue(event))),
      };
    }),
    getTask: unary(a2a, (peer, request: A2AGrpcTaskRequest) => ({
      json: JSON.stringify(projectA2AExternalValue(a2a.getGrpcTask(peer, taskRequestParams(request)))),
    })),
    cancelTask: unary(a2a, async (peer, request: A2AGrpcTaskRequest) => ({
      json: JSON.stringify(projectA2AExternalValue(await a2a.cancelGrpcTask(peer, taskRequestParams(request)))),
    })),
    subscribeToTask: async (
      call: grpc.ServerWritableStream<A2AGrpcTaskEventsRequest, { json: string }>,
    ): Promise<void> => {
      try {
        const peer = authenticateGrpcPeer(a2a, call.metadata);
        const result = a2a.getGrpcTaskEvents(peer, taskEventsRequestParams(call.request));
        for (const event of result.events) {
          call.write({ json: JSON.stringify(projectA2AExternalValue(event)) });
        }
        call.end();
      } catch (error) {
        call.destroy(toGrpcError(error));
      }
    },
    setTaskPushNotificationConfig: unary(a2a, async (peer, request: A2AGrpcJsonRequest) => ({
      json: JSON.stringify(
        projectA2AExternalValue(await a2a.setGrpcTaskPushNotificationConfig(peer, parseJsonRequest(request))),
      ),
    })),
    getTaskPushNotificationConfig: unary(a2a, (peer, request: A2AGrpcTaskRequest) => ({
      json: JSON.stringify(
        projectA2AExternalValue(a2a.getGrpcTaskPushNotificationConfig(peer, taskRequestParams(request))),
      ),
    })),
    listTaskPushNotificationConfig: unary(a2a, (peer, request: A2AGrpcJsonRequest) => ({
      json: JSON.stringify(
        projectA2AExternalValue(a2a.listGrpcTaskPushNotificationConfigs(peer, parseJsonRequest(request))),
      ),
    })),
    deleteTaskPushNotificationConfig: unary(a2a, (peer, request: A2AGrpcTaskRequest) => ({
      json: JSON.stringify(
        projectA2AExternalValue(a2a.deleteGrpcTaskPushNotificationConfig(peer, taskRequestParams(request))),
      ),
    })),
    getAuthenticatedExtendedCard: unary(a2a, (peer) => ({
      json: JSON.stringify(
        projectA2AExternalValue(
          a2a.getGrpcAuthenticatedExtendedAgentCard(peer, { checkedAt: new Date().toISOString() }),
        ),
      ),
    })),
  };
}

function unary<TRequest, TResponse>(
  a2a: A2ARouteService,
  handler: (peer: A2APeerAuthResult, request: TRequest) => Promise<TResponse> | TResponse,
): grpc.handleUnaryCall<TRequest, TResponse> {
  return (call, callback) => {
    void (async () => {
      try {
        const peer = authenticateGrpcPeer(a2a, call.metadata);
        callback(null, await handler(peer, call.request));
      } catch (error) {
        callback(toGrpcError(error));
      }
    })();
  };
}

function authenticateGrpcPeer(a2a: A2ARouteService, metadata: grpc.Metadata): A2APeerAuthResult {
  const result = a2a.authenticatePeerRequest(
    {
      headers: {
        authorization: readAuthorizationMetadata(metadata),
      },
    },
    new Date().toISOString(),
  );
  if (isPeerAuthFailure(result)) {
    throw grpcStatusError(mapAuthStatus(result.statusCode), result.message);
  }
  return result;
}

function readAuthorizationMetadata(metadata: grpc.Metadata): string | undefined {
  const value = metadata.get("authorization")[0];
  return typeof value === "string" ? value : undefined;
}

function isPeerAuthFailure(value: A2APeerAuthResult | A2APeerAuthFailure): value is A2APeerAuthFailure {
  return "statusCode" in value;
}

function mapAuthStatus(statusCode: number): grpc.status {
  if (statusCode === 401) {
    return grpc.status.UNAUTHENTICATED;
  }
  if (statusCode === 403) {
    return grpc.status.PERMISSION_DENIED;
  }
  return grpc.status.UNAVAILABLE;
}

function parseJsonRequest(request: A2AGrpcJsonRequest): Record<string, unknown> {
  return parseJsonObject(request.json);
}

function taskRequestParams(request: A2AGrpcTaskRequest): Record<string, unknown> {
  const params = parseJsonObject(request.json);
  return {
    ...params,
    taskId:
      readString(request.taskId) ?? readString(request.task_id) ?? readString(params.taskId) ?? readString(params.id),
  };
}

function taskEventsRequestParams(request: A2AGrpcTaskEventsRequest): Record<string, unknown> {
  const params = taskRequestParams(request);
  return {
    ...params,
    lastEventSequence:
      readNumber(request.lastEventSequence) ??
      readNumber(request.last_event_sequence) ??
      readNumber(params.lastEventSequence),
  };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value?.trim()) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw httpJsonServiceError(400, "a2a_grpc_invalid_json", "A2A gRPC JSON envelope must contain an object.");
  }
  return parsed as Record<string, unknown>;
}

function toGrpcError(error: unknown): grpc.ServiceError {
  if (isGrpcServiceError(error)) {
    return grpcStatusError(
      error.code,
      projectA2AExternalErrorText(error.details || error.message || "A2A gRPC request failed."),
    );
  }
  if (error instanceof A2AJsonRpcServiceError) {
    return grpcStatusError(mapA2AServiceCode(error.code), projectA2AExternalErrorText(error.message));
  }
  const routeError = error as { statusCode?: number; message?: string };
  if (typeof routeError.statusCode === "number") {
    return grpcStatusError(
      mapHttpStatus(routeError.statusCode),
      projectA2AExternalErrorText(routeError.message ?? "A2A gRPC request failed."),
    );
  }
  return grpcStatusError(
    grpc.status.INTERNAL,
    projectA2AExternalErrorText(error instanceof Error ? error.message : "A2A gRPC request failed."),
  );
}

function isGrpcServiceError(error: unknown): error is grpc.ServiceError {
  return Boolean(error && typeof error === "object" && "code" in error && "details" in error);
}

function mapA2AServiceCode(code: number): grpc.status {
  if (code === -32602) {
    return grpc.status.INVALID_ARGUMENT;
  }
  if (code === -32004) {
    return grpc.status.NOT_FOUND;
  }
  if (code === -32022) {
    return grpc.status.PERMISSION_DENIED;
  }
  return grpc.status.FAILED_PRECONDITION;
}

function mapHttpStatus(statusCode: number): grpc.status {
  if (statusCode === 400) {
    return grpc.status.INVALID_ARGUMENT;
  }
  if (statusCode === 401) {
    return grpc.status.UNAUTHENTICATED;
  }
  if (statusCode === 403) {
    return grpc.status.PERMISSION_DENIED;
  }
  if (statusCode === 404) {
    return grpc.status.NOT_FOUND;
  }
  if (statusCode === 503) {
    return grpc.status.UNAVAILABLE;
  }
  return grpc.status.INTERNAL;
}

function grpcStatusError(code: grpc.status, message: string): grpc.ServiceError {
  const error = new Error(message) as grpc.ServiceError;
  error.code = code;
  error.details = message;
  error.metadata = new grpc.Metadata();
  return error;
}
