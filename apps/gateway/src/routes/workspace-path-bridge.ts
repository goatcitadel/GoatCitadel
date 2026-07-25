import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  WORKSPACE_PATH_BRIDGE_MAX_LIST_LIMIT,
  WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH,
  type WorkspacePathBridgeResolveRequest,
  type WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import { isWorkspacePathBridgeUnsupportedFlavorError } from "../services/workspace-path-bridge-errors.js";
import { sendRouteError } from "./_error-handler.js";
import { withRouteAccess } from "./route-access.js";

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const workspaceId = identifier;
const flavor = z.enum(["windows_native", "windows_forward", "msys", "wsl", "posix"]);

const resolveBodySchema = z
  .object({
    verificationId: identifier,
    workspaceId,
    inputPath: z.string().min(1).max(WORKSPACE_PATH_BRIDGE_MAX_PATH_LENGTH),
    inputFlavor: flavor,
    targetFlavor: flavor,
    requireGitIdentity: z.boolean(),
    distro: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
      .optional(),
    expectedGitIdentitySha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const needsDistro = value.inputFlavor === "wsl" || value.targetFlavor === "wsl";
    if (needsDistro !== (value.distro !== undefined)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "WSL paths require exactly one explicit distro." });
    }
    if (value.expectedGitIdentitySha256 && !value.requireGitIdentity) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expected Git identity requires Git-bound verification.",
      });
    }
    if ((value.inputFlavor === "posix") !== (value.targetFlavor === "posix")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "POSIX and Windows path flavors cannot be translated into one another.",
      });
    }
  });

const inspectParamsSchema = z.object({ snapshotId: identifier }).strict();
const inspectQuerySchema = z.object({ workspaceId }).strict();
const listQuerySchema = z
  .object({
    workspaceId,
    limit: z.coerce.number().int().min(1).max(WORKSPACE_PATH_BRIDGE_MAX_LIST_LIMIT).optional(),
  })
  .strict();

export interface WorkspacePathBridgeRouteService {
  resolve(
    request: WorkspacePathBridgeResolveRequest,
    options?: { signal?: AbortSignal },
  ): Promise<WorkspacePathBridgeSnapshotRecord>;
  inspect(workspaceId: string, snapshotId: string): WorkspacePathBridgeSnapshotRecord;
  list(workspaceId: string, limit?: number): WorkspacePathBridgeSnapshotRecord[];
}

export interface WorkspacePathBridgeRoutesOptions {
  service: WorkspacePathBridgeRouteService;
}

export const workspacePathBridgeRoutes: FastifyPluginAsync<WorkspacePathBridgeRoutesOptions> = async (
  fastify,
  options,
) => {
  if (!options.service) {
    throw new Error("Workspace path bridge routes require an explicit service.");
  }
  const operatorOnly = withRouteAccess(fastify, "operator", {
    onRequest: async (_request, reply) => {
      markInspectionOnly(reply);
    },
  });

  fastify.post("/api/v1/ops/workspace-path-bridges/resolve", operatorOnly, async (request, reply) => {
    markInspectionOnly(reply);
    const body = resolveBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "Invalid workspace path bridge request." });
    }
    const abort = bindRequestAbort(request.raw);
    try {
      return reply.send(await options.service.resolve(body.data, { signal: abort.signal }));
    } catch (error) {
      if (isConflict(error)) {
        return reply.code(409).send({ error: "Workspace path bridge evidence changed; use a new verification id." });
      }
      if (isWorkspacePathBridgeUnsupportedFlavorError(error)) {
        return reply.code(422).send({ error: error.message, code: error.code, hostPlatform: error.hostPlatform });
      }
      return sendRouteError(reply, error, request.log);
    } finally {
      abort.dispose();
    }
  });

  fastify.get("/api/v1/ops/workspace-path-bridges/:snapshotId", operatorOnly, async (request, reply) => {
    markInspectionOnly(reply);
    const params = inspectParamsSchema.safeParse(request.params);
    const query = inspectQuerySchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: "Invalid workspace path bridge inspection query." });
    }
    try {
      return reply.send(options.service.inspect(query.data.workspaceId, params.data.snapshotId));
    } catch (error) {
      if (isWorkspaceScopeMiss(error)) {
        return reply.code(404).send({ error: "Workspace path bridge snapshot not found." });
      }
      return sendRouteError(reply, error, request.log);
    }
  });

  fastify.get("/api/v1/ops/workspace-path-bridges", operatorOnly, async (request, reply) => {
    markInspectionOnly(reply);
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid workspace path bridge list query." });
    }
    try {
      return reply.send({
        workspaceId: query.data.workspaceId,
        snapshots: options.service.list(query.data.workspaceId, query.data.limit ?? 50),
      });
    } catch (error) {
      return sendRouteError(reply, error, request.log);
    }
  });
};

function markInspectionOnly(reply: { header(name: string, value: string): unknown }): void {
  reply.header("cache-control", "no-store, max-age=0");
  reply.header("pragma", "no-cache");
  reply.header("x-goatcitadel-execution-authority", "none");
}

function isConflict(error: unknown): boolean {
  return (
    error instanceof Error && /conflicts with (?:an immutable request|current filesystem evidence)/u.test(error.message)
  );
}

function isWorkspaceScopeMiss(error: unknown): boolean {
  return error instanceof Error && /outside the requested workspace|not found/u.test(error.message);
}

function bindRequestAbort(raw: object): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const request = raw as {
    aborted?: boolean;
    once?: (event: string, listener: () => void) => unknown;
    off?: (event: string, listener: () => void) => unknown;
  };
  const onAborted = () => controller.abort();
  if (request.aborted) controller.abort();
  request.once?.("aborted", onAborted);
  return {
    signal: controller.signal,
    dispose: () => {
      request.off?.("aborted", onAborted);
    },
  };
}
