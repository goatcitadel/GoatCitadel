import * as grpc from "@grpc/grpc-js";
import type { A2AJsonRpcMethod, A2AJsonRpcResponse, A2AOutboundPeerConfig } from "@goatcitadel/contracts";
import { assertHostAllowed } from "@goatcitadel/policy-engine";
import {
  type A2AGrpcClientShape,
  type A2AGrpcJsonEnvelope,
  type A2AGrpcJsonRequest,
  type A2AGrpcTaskEnvelope,
  type A2AGrpcTaskEventEnvelope,
  type A2AGrpcTaskEventsEnvelope,
  type A2AGrpcTaskEventsRequest,
  type A2AGrpcTaskRequest,
  loadA2AGrpcClientConstructor,
} from "./a2a-grpc-proto.js";
import { buildOutboundHeaders, jsonRpcResult, readNumber, readString } from "./a2a-route-utils.js";

const A2A_GRPC_CALL_TIMEOUT_MS = 15_000;

export interface A2AGrpcOutboundCallInput {
  grpcUrl: string;
  method: A2AJsonRpcMethod;
  params: Record<string, unknown>;
  id?: string | number | null;
  peer: Pick<A2AOutboundPeerConfig, "token" | "tokenEnv">;
  allowlist: string[];
}

export interface A2AGrpcClientPort {
  call(input: A2AGrpcOutboundCallInput): Promise<A2AJsonRpcResponse>;
}

export class A2AGrpcClient implements A2AGrpcClientPort {
  public async call(input: A2AGrpcOutboundCallInput): Promise<A2AJsonRpcResponse> {
    const endpoint = parseGrpcEndpoint(input.grpcUrl);
    assertHostAllowed(endpoint.allowlistUrl, input.allowlist);
    const ClientConstructor = loadA2AGrpcClientConstructor();
    const client = new ClientConstructor(
      endpoint.target,
      grpc.credentials.createInsecure(),
    ) as unknown as A2AGrpcClientShape;
    const metadata = buildGrpcMetadata(input.peer);
    try {
      return await callA2AGrpcMethod(client, metadata, input);
    } finally {
      client.close();
    }
  }
}

function buildGrpcMetadata(peer: Pick<A2AOutboundPeerConfig, "token" | "tokenEnv">): grpc.Metadata {
  const metadata = new grpc.Metadata();
  const authorization = buildOutboundHeaders(peer).authorization;
  if (authorization) {
    metadata.set("authorization", authorization);
  }
  return metadata;
}

async function callA2AGrpcMethod(
  client: A2AGrpcClientShape,
  metadata: grpc.Metadata,
  input: A2AGrpcOutboundCallInput,
): Promise<A2AJsonRpcResponse> {
  switch (input.method) {
    case "SendMessage":
      return jsonRpcResult(input.id, {
        task: parseTaskEnvelope(await callUnary(client, "sendMessage", jsonRequest(input.params), metadata)),
      });
    case "SendStreamingMessage": {
      const envelope = await callUnary<A2AGrpcJsonRequest, A2AGrpcTaskEventsEnvelope>(
        client,
        "sendStreamingMessage",
        jsonRequest(input.params),
        metadata,
      );
      return jsonRpcResult(input.id, {
        task: parseJson(envelope.taskJson ?? envelope.task_json),
        events: (envelope.eventJson ?? envelope.event_json ?? []).map((item: string) => parseJson(item)),
      });
    }
    case "GetTask":
      return jsonRpcResult(input.id, {
        task: parseTaskEnvelope(await callUnary(client, "getTask", taskRequest(input.params), metadata)),
      });
    case "CancelTask":
      return jsonRpcResult(input.id, {
        task: parseTaskEnvelope(await callUnary(client, "cancelTask", taskRequest(input.params), metadata)),
      });
    case "SubscribeToTask":
      return jsonRpcResult(input.id, {
        events: await collectTaskEvents(client, taskEventsRequest(input.params), metadata),
      });
    case "SetTaskPushNotificationConfig":
      return jsonRpcResult(input.id, {
        config: parseJsonEnvelope(
          await callUnary(client, "setTaskPushNotificationConfig", jsonRequest(input.params), metadata),
        ),
      });
    case "GetTaskPushNotificationConfig":
      return jsonRpcResult(input.id, {
        config: parseJsonEnvelope(
          await callUnary(client, "getTaskPushNotificationConfig", taskRequest(input.params), metadata),
        ),
      });
    case "ListTaskPushNotificationConfig":
      return jsonRpcResult(input.id, {
        configs: parseJsonEnvelope(
          await callUnary(client, "listTaskPushNotificationConfig", jsonRequest(input.params), metadata),
        ),
      });
    case "DeleteTaskPushNotificationConfig":
      return jsonRpcResult(input.id, {
        deleted: parseJsonEnvelope(
          await callUnary(client, "deleteTaskPushNotificationConfig", taskRequest(input.params), metadata),
        ),
      });
    case "GetAuthenticatedExtendedCard":
      return jsonRpcResult(input.id, {
        agentCard: parseJsonEnvelope(await callUnary(client, "getAuthenticatedExtendedCard", {}, metadata)),
      });
  }
}

function callUnary<TRequest, TResponse>(
  client: A2AGrpcClientShape,
  method: keyof A2AGrpcClientShape,
  request: TRequest,
  metadata: grpc.Metadata,
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    const fn = client[method] as unknown as (
      req: TRequest,
      meta: grpc.Metadata,
      options: grpc.CallOptions,
      callback: grpc.requestCallback<TResponse>,
    ) => grpc.ClientUnaryCall;
    fn.call(
      client,
      request,
      metadata,
      { deadline: new Date(Date.now() + A2A_GRPC_CALL_TIMEOUT_MS) },
      (error, value) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(value as TResponse);
      },
    );
  });
}

function collectTaskEvents(
  client: A2AGrpcClientShape,
  request: A2AGrpcTaskEventsRequest,
  metadata: grpc.Metadata,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const stream = client.subscribeToTask(request, metadata);
    const timeout = setTimeout(() => {
      stream.cancel();
      reject(new Error("A2A gRPC SubscribeToTask timed out."));
    }, A2A_GRPC_CALL_TIMEOUT_MS);
    stream.on("data", (event: A2AGrpcTaskEventEnvelope) => {
      events.push(parseJson(event.json));
    });
    stream.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    stream.on("end", () => {
      clearTimeout(timeout);
      resolve(events);
    });
  });
}

function jsonRequest(params: Record<string, unknown>): A2AGrpcJsonRequest {
  return { json: JSON.stringify(params) };
}

function taskRequest(params: Record<string, unknown>): A2AGrpcTaskRequest {
  return {
    taskId: readTaskId(params),
    json: JSON.stringify(params),
  };
}

function taskEventsRequest(params: Record<string, unknown>): A2AGrpcTaskEventsRequest {
  return {
    taskId: readTaskId(params),
    lastEventSequence: readNumber(params.lastEventSequence) ?? 0,
    json: JSON.stringify(params),
  };
}

function readTaskId(params: Record<string, unknown>): string {
  const taskId = readString(params.taskId) ?? readString(params.id);
  if (!taskId) {
    throw new Error("A2A gRPC request requires taskId.");
  }
  return taskId;
}

function parseTaskEnvelope(value: A2AGrpcTaskEnvelope): unknown {
  return parseJson(value.json);
}

function parseJsonEnvelope(value: A2AGrpcJsonEnvelope): unknown {
  return parseJson(value.json);
}

function parseJson(value: string | undefined): unknown {
  if (!value?.trim()) {
    return {};
  }
  return JSON.parse(value);
}

function parseGrpcEndpoint(value: string): { target: string; allowlistUrl: string } {
  const trimmed = value.trim();
  const parsed = new URL(trimmed.includes("://") ? trimmed : `grpc://${trimmed}`);
  if (!parsed.host) {
    throw new Error("A2A gRPC URL must include a host and port.");
  }
  return {
    target: parsed.host,
    allowlistUrl: `grpc://${parsed.host}`,
  };
}
