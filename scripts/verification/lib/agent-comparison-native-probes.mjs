import { randomUUID } from "node:crypto";
import path from "node:path";

// Every target is a harness-created fixture. In particular, the sibling read
// tests the declared workspace boundary without touching operator-owned data.
export function createNativeConformanceProbes({ workspace, permissions = false }) {
  const nonce = randomUUID();
  const markerFile = path.join(workspace, "terminal-result.txt");
  const terminalMarker = `CONTROLLED_TERMINAL_${nonce}`;
  const probes = [
    {
      id: "workspace_read",
      names: ["read_file", "read"],
      filename: path.join(workspace, "fixture.txt"),
      marker: `CONTROLLED_FILE_${nonce}`,
    },
    ...(permissions
      ? [
          {
            id: "sibling_read",
            names: ["read_file", "read"],
            filename: path.join(path.dirname(workspace), "sibling-fixture.txt"),
            marker: `CONTROLLED_SIBLING_${nonce}`,
          },
          { id: "terminal", names: ["terminal", "exec"], marker: terminalMarker },
        ]
      : []),
  ];
  const fixtures = probes
    .filter((probe) => probe.filename)
    .map((probe) => ({ filename: probe.filename, content: probe.marker }));
  if (permissions)
    fixtures.push({
      filename: path.join(workspace, "terminal-probe.cjs"),
      content: `const fs = require("node:fs");\nconst path = require("node:path");\nfs.writeFileSync(path.join(__dirname, "terminal-result.txt"), ${JSON.stringify(terminalMarker)}, { flag: "wx" });\n`,
    });
  const state = new Map(probes.map((probe) => [probe.id, { requested: false, result: null, unsupported: false }]));
  return {
    fixtures,
    markerFile,
    respond(body) {
      // Auxiliary requests (for example a summary) can share the same proxy.
      // Their absent tool catalog says nothing about the main agent's tools.
      if (!body.tools?.length) return { role: "assistant", content: "LOCAL_PROFILE_OK" };
      const messages = Array.isArray(body.messages) ? body.messages : [];
      for (const probe of probes) {
        const entry = state.get(probe.id);
        if (!entry.requested) continue;
        const results = messages.filter(
          (message) => message.role === "tool" && message.tool_call_id === callId(probe.id),
        );
        if (results.length) {
          const content = results.at(-1).content;
          entry.result = typeof content === "string" ? content : JSON.stringify(content);
        }
      }
      for (const probe of probes) {
        const entry = state.get(probe.id);
        if (entry.result !== null || entry.unsupported) continue;
        const tool = body.tools?.find((tool) => probe.names.includes(tool.function?.name));
        const fields = tool?.function?.parameters?.properties ?? {};
        let args;
        if (probe.filename) {
          const field = ["path", "file_path"].find((key) => Object.hasOwn(fields, key));
          if (field) args = { [field]: probe.filename };
        } else if (Object.hasOwn(fields, "command") && Object.hasOwn(fields, "workdir")) {
          // No interpolated shell text: the path is a separate native tool field.
          args = { command: "node ./terminal-probe.cjs", workdir: workspace };
        }
        if (!tool || !args) {
          entry.unsupported = true;
          continue;
        }
        entry.requested = true;
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId(probe.id),
              type: "function",
              function: { name: tool.function.name, arguments: JSON.stringify(args) },
            },
          ],
        };
      }
      return { role: "assistant", content: "LOCAL_PROFILE_OK" };
    },
    evidence(terminalBytes = null) {
      return Object.fromEntries(
        probes.map((probe) => {
          const entry = state.get(probe.id);
          // A terminal result can quote its input even when execution failed.
          // Only the independently read, create-only marker proves execution.
          const allowed =
            probe.id === "terminal" ? terminalBytes === probe.marker : entry.result?.includes(probe.marker);
          const denial =
            /(?:path (?:escapes|is outside)|outside (?:the )?(?:workspace|allowed)|access denied|permission denied|command denied|execution denied|exec denied|blocked by policy)/iu.test(
              entry.result ?? "",
            );
          const approval =
            /(?:approval (?:is )?required|requires? (?:an? )?approval|awaiting approval|approval pending)/iu.test(
              entry.result ?? "",
            );
          const approvalUnavailable = /exec approval registration failed/iu.test(entry.result ?? "");
          return [
            probe.id,
            {
              requested: entry.requested,
              resultSeen: entry.result !== null,
              outcome: allowed
                ? "allowed"
                : entry.unsupported
                  ? "unsupported"
                  : approvalUnavailable
                    ? "approval_unavailable"
                    : approval
                      ? "approval_required"
                      : denial
                        ? "denied"
                        : "inconclusive",
              nativeResult: entry.result,
            },
          ];
        }),
      );
    },
  };
}

// The pinned OpenClaw serializer removes punctuation from provider call IDs.
// Emit a shared alphanumeric ID instead of loosely matching returned IDs.
function callId(probeId) {
  return `callcomparison${probeId.replaceAll("_", "")}`;
}

export function evaluateNativeConformancePolicy(evidence, policy, permissions) {
  const expected = {
    workspace_read: ["allowed"],
    ...(permissions
      ? {
          sibling_read:
            policy.files === "workspace_only" ? ["denied"] : policy.files === "host_user" ? ["allowed"] : [],
          terminal: ["per_command_approval", "allowlist_miss_approval"].includes(policy.terminal)
            ? ["approval_required", "approval_unavailable"]
            : ["risk_based_approval", "unrestricted"].includes(policy.terminal)
              ? ["allowed"]
              : policy.terminal === "denied"
                ? ["denied"]
                : [],
        }
      : {}),
  };
  const checks = Object.fromEntries(
    Object.entries(expected).map(([name, outcomes]) => {
      const observed = evidence[name]?.outcome;
      const state =
        !outcomes.length || !observed || ["unsupported", "inconclusive"].includes(observed)
          ? "unverified"
          : outcomes.includes(observed)
            ? "matched"
            : "mismatch";
      return [name, { expected: outcomes, observed: observed ?? null, state }];
    }),
  );
  return {
    status: Object.values(checks).some((check) => check.state === "mismatch")
      ? "mismatch"
      : Object.values(checks).every((check) => check.state === "matched")
        ? "matched"
        : "unverified",
    checks,
  };
}
