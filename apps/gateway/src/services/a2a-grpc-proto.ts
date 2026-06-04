import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export const A2A_GRPC_PROTO_SOURCE = `syntax = "proto3";

package goatcitadel.a2a.v1;

service A2AGateway {
  rpc sendMessage(A2AJsonRequest) returns (A2ATaskEnvelope);
  rpc sendStreamingMessage(A2AJsonRequest) returns (A2ATaskEventsEnvelope);
  rpc getTask(A2ATaskRequest) returns (A2ATaskEnvelope);
  rpc cancelTask(A2ATaskRequest) returns (A2ATaskEnvelope);
  rpc subscribeToTask(A2ATaskEventsRequest) returns (stream A2ATaskEventEnvelope);
  rpc setTaskPushNotificationConfig(A2AJsonRequest) returns (A2AJsonEnvelope);
  rpc getTaskPushNotificationConfig(A2ATaskRequest) returns (A2AJsonEnvelope);
  rpc listTaskPushNotificationConfig(A2AJsonRequest) returns (A2AJsonEnvelope);
  rpc deleteTaskPushNotificationConfig(A2ATaskRequest) returns (A2AJsonEnvelope);
  rpc getAuthenticatedExtendedCard(A2AEmpty) returns (A2AJsonEnvelope);
}

message A2AJsonRequest {
  string json = 1;
}

message A2ATaskRequest {
  string task_id = 1;
  string json = 2;
}

message A2ATaskEventsRequest {
  string task_id = 1;
  uint32 last_event_sequence = 2;
  string json = 3;
}

message A2ATaskEnvelope {
  string json = 1;
}

message A2ATaskEventsEnvelope {
  string task_json = 1;
  repeated string event_json = 2;
}

message A2ATaskEventEnvelope {
  string json = 1;
}

message A2AJsonEnvelope {
  string json = 1;
}

message A2AEmpty {}
`;

export interface A2AGrpcJsonRequest {
  json?: string;
}

export interface A2AGrpcTaskRequest {
  taskId?: string;
  task_id?: string;
  json?: string;
}

export interface A2AGrpcTaskEventsRequest extends A2AGrpcTaskRequest {
  lastEventSequence?: number;
  last_event_sequence?: number;
}

export interface A2AGrpcTaskEnvelope {
  json?: string;
}

export interface A2AGrpcTaskEventsEnvelope {
  taskJson?: string;
  task_json?: string;
  eventJson?: string[];
  event_json?: string[];
}

export interface A2AGrpcJsonEnvelope {
  json?: string;
}

export interface A2AGrpcTaskEventEnvelope {
  json?: string;
}

export interface A2AGrpcClientShape extends grpc.Client {
  sendMessage(
    request: A2AGrpcJsonRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcTaskEnvelope>,
  ): grpc.ClientUnaryCall;
  sendStreamingMessage(
    request: A2AGrpcJsonRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcTaskEventsEnvelope>,
  ): grpc.ClientUnaryCall;
  getTask(
    request: A2AGrpcTaskRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcTaskEnvelope>,
  ): grpc.ClientUnaryCall;
  cancelTask(
    request: A2AGrpcTaskRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcTaskEnvelope>,
  ): grpc.ClientUnaryCall;
  subscribeToTask(
    request: A2AGrpcTaskEventsRequest,
    metadata: grpc.Metadata,
  ): grpc.ClientReadableStream<A2AGrpcTaskEventEnvelope>;
  setTaskPushNotificationConfig(
    request: A2AGrpcJsonRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcJsonEnvelope>,
  ): grpc.ClientUnaryCall;
  getTaskPushNotificationConfig(
    request: A2AGrpcTaskRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcJsonEnvelope>,
  ): grpc.ClientUnaryCall;
  listTaskPushNotificationConfig(
    request: A2AGrpcJsonRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcJsonEnvelope>,
  ): grpc.ClientUnaryCall;
  deleteTaskPushNotificationConfig(
    request: A2AGrpcTaskRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcJsonEnvelope>,
  ): grpc.ClientUnaryCall;
  getAuthenticatedExtendedCard(
    request: Record<string, never>,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<A2AGrpcJsonEnvelope>,
  ): grpc.ClientUnaryCall;
}

type A2AGrpcLoadedPackage = {
  goatcitadel: {
    a2a: {
      v1: {
        A2AGateway: grpc.ServiceClientConstructor;
      };
    };
  };
};

export function loadA2AGrpcClientConstructor(): grpc.ServiceClientConstructor {
  return loadA2AGrpcPackage().goatcitadel.a2a.v1.A2AGateway;
}

export function loadA2AGrpcServiceDefinition(): grpc.ServiceDefinition {
  return loadA2AGrpcClientConstructor().service;
}

function loadA2AGrpcPackage(): A2AGrpcLoadedPackage {
  const definition = protoLoader.loadSync(writeProtoFile(), {
    defaults: true,
    enums: String,
    keepCase: false,
    longs: String,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(definition) as unknown as A2AGrpcLoadedPackage;
}

function writeProtoFile(): string {
  const digest = createHash("sha256").update(A2A_GRPC_PROTO_SOURCE).digest("hex").slice(0, 16);
  const protoPath = path.join(os.tmpdir(), `goatcitadel-a2a-v1-${digest}.proto`);
  if (!fs.existsSync(protoPath)) {
    fs.writeFileSync(protoPath, A2A_GRPC_PROTO_SOURCE, "utf8");
  }
  return protoPath;
}
