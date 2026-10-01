import type { McpCreateInput } from "../../../features/native-routes/settings/mcp-create-binding";

const text = (value: string | undefined) => value?.replaceAll("_", " ") ?? "Not specified";
export function McpCreateReview({ input }: { input: McpCreateInput }) {
  return (
    <section aria-label="Reviewed MCP registration" className="space-y-3 text-sm text-fg-secondary">
      <h4 className="font-semibold text-fg">Exact configuration to register</h4>
      <p>
        This saves a new server for the whole installation. No connection, process launch, OAuth handshake or tool call
        is performed.
      </p>
      <dl className="cockpit-definition-grid grid gap-x-3 gap-y-2">
        <dt>Label</dt>
        <dd className="break-words">{input.label}</dd>
        <dt>Transport</dt>
        <dd>{input.transport}</dd>
        <dt>{input.transport === "stdio" ? "Command" : "URL"}</dt>
        <dd>
          <code className="break-all font-mono">{input.command ?? input.url}</code>
        </dd>
        <dt>Saved state</dt>
        <dd>{input.enabled ? "Enabled" : "Disabled"}</dd>
        <dt>Category</dt>
        <dd>{text(input.category)}</dd>
        <dt>Trust</dt>
        <dd>{text(input.trustTier)}</dd>
        <dt>Cost</dt>
        <dd>{text(input.costTier)}</dd>
        <dt>Authentication</dt>
        <dd>
          {input.authType === "none"
            ? "None configured"
            : input.authType === "oauth2"
              ? "OAuth configuration only"
              : "Token environment references"}
        </dd>
        <dt>First tool approval</dt>
        <dd>
          {input.policy?.requireFirstToolApproval ? "Required by this server policy" : "Gateway policy still applies"}
        </dd>
        <dt>Redaction</dt>
        <dd>{text(input.policy?.redactionMode)}</dd>
      </dl>
      {input.args?.length ? (
        <div>
          <h5 className="font-semibold">Ordered arguments</h5>
          <ol className="list-inside list-decimal">
            {input.args.map((arg, index) => (
              <li key={index}>
                <code className="break-all font-mono">{arg}</code>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {[
        ["Allowed tool patterns", input.policy?.allowedToolPatterns],
        ["Blocked tool patterns", input.policy?.blockedToolPatterns],
        ["Environment key names", input.policy?.allowedEnvKeys],
      ].map(([label, values]) =>
        Array.isArray(values) && values.length ? (
          <div key={String(label)}>
            <h5 className="font-semibold">{label}</h5>
            <ul className="list-inside list-disc">
              {values.map((value, index) => (
                <li key={index}>
                  <code className="break-all font-mono">{value}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {input.policy?.notes ? (
        <p className="whitespace-pre-wrap break-words">Policy note: {input.policy.notes}</p>
      ) : null}
      {input.oauth ? (
        <details>
          <summary>OAuth configuration references</summary>
          <dl className="mt-2 space-y-1">
            {Object.entries(input.oauth)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                  <dd>
                    <code className="break-all font-mono">
                      {Array.isArray(value) ? value.join(", ") : String(value)}
                    </code>
                  </dd>
                </div>
              ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}
