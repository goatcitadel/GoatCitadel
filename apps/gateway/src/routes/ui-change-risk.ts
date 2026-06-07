import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type {
  ChangeRiskEvaluationItem,
  ChangeRiskEvaluationResponse,
  ChangeRiskLevel,
} from "@goatcitadel/contracts";

const bodySchema = z.object({
  pageId: z.string().min(1),
  changes: z.array(z.object({
    field: z.string().min(1),
    from: z.unknown(),
    to: z.unknown(),
  })).max(200),
});

export const uiChangeRiskRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/api/v1/ui/change-risk/evaluate", async (request, reply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const items = parsed.data.changes.map((change) => evaluateItem(parsed.data.pageId, change.field, change.from, change.to));
    const overall = deriveOverall(items);
    const response: ChangeRiskEvaluationResponse = {
      pageId: parsed.data.pageId,
      overall,
      items,
    };
    return reply.send(response);
  });
};

function evaluateItem(pageId: string, field: string, from: unknown, to: unknown): ChangeRiskEvaluationItem {
  const normalizedField = field.toLowerCase();
  const next = stringifyValue(to);
  const prev = stringifyValue(from);

  if (next === prev) {
    return {
      field,
      level: "safe",
      reasonCodes: ["no_change"],
      hint: "No effective change.",
    };
  }

  if (normalizedField.includes("toolprofile") && next === "danger") {
    return {
      field,
      level: "critical",
      reasonCodes: ["danger_profile"],
      hint: "Danger profile can enable destructive tools. Confirm this is intentional.",
    };
  }

  if (normalizedField.includes("allowlist")) {
    if (!next.trim()) {
      return {
        field,
        level: "warning",
        reasonCodes: ["allowlist_empty"],
        hint: "Empty allowlist blocks outbound networking.",
      };
    }
    if (next.includes("*")) {
      return {
        field,
        level: "warning",
        reasonCodes: ["allowlist_wildcard"],
        hint: "Wildcard '*' allowlist entry opens access to all public hosts.",
      };
    }
  }

  if (normalizedField.includes("baseurl") || normalizedField.includes("providerbaseurl")) {
    const risk = evaluateUrlRisk(next);
    if (risk) {
      return {
        field,
        level: risk.level,
        reasonCodes: [risk.code],
        hint: risk.hint,
      };
    }
  }

  if (normalizedField.includes("authmode") && next !== "none") {
    return {
      field,
      level: "warning",
      reasonCodes: ["auth_mode_changed"],
      hint: "Auth changes can block clients until credentials are updated.",
    };
  }

  if (normalizedField.startsWith("auth.") && normalizedField.includes("password")) {
    return {
      field,
      level: "critical",
      reasonCodes: ["auth_secret_change"],
      hint: "Credential changes can lock out clients. Confirm intended update.",
    };
  }

  if (normalizedField.startsWith("integration.") && normalizedField.includes("config")) {
    if (next.includes("http://") && !next.includes("127.0.0.1") && !next.includes("localhost")) {
      return {
        field,
        level: "critical",
        reasonCodes: ["integration_plain_http"],
        hint: "Remote plain HTTP endpoint detected. Use HTTPS for production safety.",
      };
    }
    if (next.toLowerCase().includes("token") || next.toLowerCase().includes("secret")) {
      return {
        field,
        level: "warning",
        reasonCodes: ["integration_secret_inline"],
        hint: "Prefer ENV-backed secret references instead of inline credential values.",
      };
    }
  }

  if ((pageId === "files" || normalizedField.startsWith("paths.") || normalizedField.includes("path")) && normalizedField.includes("path")) {
    if (next.includes("..")) {
      return {
        field,
        level: "critical",
        reasonCodes: ["path_traversal_pattern"],
        hint: "Relative traversal patterns are blocked by policy.",
      };
    }
    if (!next.startsWith("artifacts/") && !next.startsWith("notes/") && !next.startsWith("memory/")) {
      return {
        field,
        level: "warning",
        reasonCodes: ["nonstandard_path"],
        hint: "Use a standard workspace folder unless you need a custom path.",
      };
    }
  }

  return {
    field,
    level: "safe",
    reasonCodes: ["changed"],
    hint: "Change looks low risk.",
  };
}

function evaluateUrlRisk(value: string): { level: ChangeRiskLevel; code: string; hint: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return {
      level: "critical",
      code: "invalid_url",
      hint: "Provider URL is not a valid URL.",
    };
  }

  if (!["https:", "http:"].includes(parsed.protocol)) {
    return {
      level: "critical",
      code: "invalid_protocol",
      hint: "Only http/https URLs are supported.",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return {
      level: "warning",
      code: "local_provider",
      hint: "Local provider selected; ensure local runtime is running.",
    };
  }

  return undefined;
}

function deriveOverall(items: ChangeRiskEvaluationItem[]): ChangeRiskLevel {
  if (items.some((item) => item.level === "critical")) {
    return "critical";
  }
  if (items.some((item) => item.level === "warning")) {
    return "warning";
  }
  return "safe";
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
