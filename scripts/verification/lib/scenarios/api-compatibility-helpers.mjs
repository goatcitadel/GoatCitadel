import fs from "node:fs/promises";
import path from "node:path";

import { repoRoot } from "../shared.mjs";

export const API_COMPAT_BASELINE_PATH = path.join(
  repoRoot,
  "scripts",
  "verification",
  "baselines",
  "api-compat",
  "rest-sse.json",
);

export const API_COMPAT_ALLOWLIST_PATH = path.join(
  repoRoot,
  "scripts",
  "verification",
  "baselines",
  "api-compat",
  "allowlist.json",
);

export async function snapshotApiCompatibilityCurrentShellFacts(gatewayUrl, deps) {
  const { assertOk, requestJson, seedMissionControlNextFixture } = deps;
  const fixture = await seedMissionControlNextFixture(gatewayUrl);
  const routeSpecs = [
    {
      key: "approvals",
      path: "/api/v1/approvals?status=pending&limit=20",
      assertBody: (body) => Array.isArray(body?.items),
    },
    {
      key: "events",
      path: "/api/v1/events?limit=20",
      assertBody: (body) => Array.isArray(body?.items),
    },
    {
      key: "runtimeLifecycle",
      path: `/api/v1/runtime/lifecycle?sessionId=${encodeURIComponent(fixture.sessionId)}`,
      assertBody: (body) => Boolean(body && typeof body === "object"),
    },
    {
      key: "codeRecoveryRuns",
      path: `/api/v1/code-mode/runs?limit=5&workspaceId=${encodeURIComponent(fixture.workspaceId)}&sessionId=${encodeURIComponent(fixture.sessionId)}`,
      assertBody: (body) => Array.isArray(body?.items),
    },
    {
      key: "coworkRecoveryRuns",
      path: `/api/v1/agentic/runs?workspaceId=${encodeURIComponent(fixture.workspaceId)}&surface=cowork&limit=5`,
      assertBody: (body) => Array.isArray(body?.items),
    },
    {
      key: "codeBackends",
      path: "/api/v1/code-mode/execution-backends",
      assertBody: (body) => Array.isArray(body?.items),
    },
    {
      key: "mcpServers",
      path: "/api/v1/mcp/servers",
      assertBody: (body) => Array.isArray(body?.items),
    },
    {
      key: "mcpRemotePreview",
      path: "/api/v1/mcp/remote-preview",
      assertBody: (body) =>
        Boolean(body?.summary) &&
        typeof body.summary.needsAuth === "number" &&
        (Array.isArray(body?.items) ? body.items.every((item) => typeof item.authReadiness === "string") : true),
    },
    {
      key: "meshReadiness",
      path: "/api/v1/mesh/readiness",
      assertBody: (body) => body?.evidenceLane === "verify:mesh:readiness",
    },
    {
      key: "diagnosticsSnapshot",
      path: "/api/v1/dev/verification/diagnostics-snapshot",
      assertBody: (body) => Boolean(body && typeof body === "object"),
    },
  ];
  const routes = {};
  for (const spec of routeSpecs) {
    const response = await requestJson(gatewayUrl, spec.path);
    assertOk(response, `api compatibility current-shell fact ${spec.key}`);
    if (!spec.assertBody(response.body)) {
      throw new Error(`api compatibility current-shell fact ${spec.key} returned an unexpected body shape`);
    }
    routes[spec.key] = {
      path: spec.path,
      status: response.status,
      shape: describeApiCompatibilityBody(response.body),
    };
  }
  return {
    fixture: {
      workspaceId: fixture.workspaceId,
      sessionId: fixture.sessionId,
      approvalId: fixture.approvalId,
    },
    routes,
  };
}

export function snapshotRestContract(openApiDocument) {
  const paths =
    openApiDocument &&
    typeof openApiDocument === "object" &&
    openApiDocument.paths &&
    typeof openApiDocument.paths === "object"
      ? openApiDocument.paths
      : {};
  return Object.fromEntries(
    Object.entries(paths)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([routePath, methods]) => [
        routePath,
        Object.fromEntries(
          Object.entries(methods ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([method, definition]) => [
              method,
              {
                responses: Object.keys(definition?.responses ?? {}).sort(),
              },
            ]),
        ),
      ]),
  );
}

export async function snapshotRealtimeContract() {
  const monitoringPath = path.join(repoRoot, "packages", "contracts", "src", "monitoring.ts");
  const source = await fs.readFile(monitoringPath, "utf8");
  const eventTypesMatch = source.match(/export type RealtimeEventType =([\s\S]*?);/);
  const realtimeInterfaceMatch = source.match(/export interface RealtimeEvent \{([\s\S]*?)\n\}/);
  const eventTypes = [...(eventTypesMatch?.[1]?.matchAll(/"([^"]+)"/g) ?? [])].map((match) => match[1]).sort();
  const envelopeFields = (realtimeInterfaceMatch?.[1] ?? "")
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*([a-zA-Z0-9_]+)\??:/)?.[1] ?? null)
    .filter(Boolean)
    .sort();
  return {
    eventTypes,
    envelopeFields,
  };
}

export function compareRestContract(baseline, current, allowlist) {
  const issues = [];
  for (const [routePath, baselineMethods] of Object.entries(baseline)) {
    if (!current[routePath]) {
      if (!allowlist.removedRestPaths?.includes(routePath)) {
        issues.push(`REST path removed: ${routePath}`);
      }
      continue;
    }
    for (const [method, baselineDefinition] of Object.entries(baselineMethods ?? {})) {
      if (!current[routePath]?.[method]) {
        const allowlistKey = `${String(method).toUpperCase()} ${routePath}`;
        if (!allowlist.removedRestMethods?.includes(allowlistKey)) {
          issues.push(`REST method removed: ${allowlistKey}`);
        }
        continue;
      }
      for (const responseCode of baselineDefinition?.responses ?? []) {
        const allowlistKey = `${String(method).toUpperCase()} ${routePath} -> ${responseCode}`;
        if (
          !current[routePath][method].responses.includes(responseCode) &&
          !allowlist.removedRestResponses?.includes(allowlistKey)
        ) {
          issues.push(`REST response removed: ${allowlistKey}`);
        }
      }
    }
  }
  return issues;
}

export function compareRealtimeContract(baseline, current, allowlist) {
  const issues = [];
  for (const eventType of baseline.eventTypes ?? []) {
    if (!current.eventTypes.includes(eventType) && !allowlist.removedSseEventTypes?.includes(eventType)) {
      issues.push(`SSE event type removed: ${eventType}`);
    }
  }
  for (const field of baseline.envelopeFields ?? []) {
    if (!current.envelopeFields.includes(field) && !allowlist.removedSseEnvelopeFields?.includes(field)) {
      issues.push(`SSE envelope field removed: ${field}`);
    }
  }
  return issues;
}

function describeApiCompatibilityBody(body) {
  if (!body || typeof body !== "object") {
    return { type: typeof body };
  }
  return {
    keys: Object.keys(body).sort(),
    itemCount: Array.isArray(body.items) ? body.items.length : undefined,
    summaryKeys: body.summary && typeof body.summary === "object" ? Object.keys(body.summary).sort() : undefined,
    evidenceLane: typeof body.evidenceLane === "string" ? body.evidenceLane : undefined,
  };
}
