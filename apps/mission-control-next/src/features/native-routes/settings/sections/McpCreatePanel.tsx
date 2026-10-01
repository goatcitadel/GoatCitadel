import type { Dispatch, SetStateAction } from "react";
import type { McpServerTemplateRecord } from "@goatcitadel/contracts";
import { Plus } from "lucide-react";
import { NativeButton } from "../../primitives";
import {
  SettingsStack,
  SettingsFieldGrid,
  SettingsField,
  SettingsNotice,
  SettingsButtonRow,
  SettingsActionList,
} from "../SettingsShared";
import { isRuntimeInvokableMcpServer } from "../helpers/mcp-helpers";
import { createMcpFormFromTemplate, type McpCreateForm } from "./mcp-editor-drafts";
export function McpCreatePanel({
  createForm,
  setCreateForm,
  busy,
  handleCreate,
  data,
}: {
  createForm: McpCreateForm;
  setCreateForm: Dispatch<SetStateAction<McpCreateForm>>;
  busy: boolean;
  handleCreate: () => Promise<boolean>;
  data: { templates: Array<McpServerTemplateRecord & { installed: boolean }> };
}) {
  return (
    <SettingsStack>
      <SettingsFieldGrid>
        <SettingsField label="Label">
          <input
            className="mc-next-settings-input"
            value={createForm.label}
            onChange={(event) => setCreateForm((current) => ({ ...current, label: event.target.value }))}
          />
        </SettingsField>
        <SettingsField label="Transport">
          <input className="mc-next-settings-input" value={createForm.transport} readOnly />
        </SettingsField>
        {createForm.transport === "stdio" ? (
          <SettingsField label="Command" span={2}>
            <input
              className="mc-next-settings-input"
              value={createForm.command}
              onChange={(event) => setCreateForm((current) => ({ ...current, command: event.target.value }))}
            />
          </SettingsField>
        ) : (
          <SettingsField label="URL" span={2}>
            <input
              className="mc-next-settings-input"
              value={createForm.url}
              onChange={(event) => setCreateForm((current) => ({ ...current, url: event.target.value }))}
            />
          </SettingsField>
        )}
        {createForm.transport === "stdio" ? (
          <SettingsField label="Arguments (one per line)" span={2}>
            <textarea
              className="mc-next-settings-input"
              value={createForm.args.join("\n")}
              onChange={(event) => setCreateForm((current) => ({ ...current, args: event.target.value.split("\n") }))}
            />
          </SettingsField>
        ) : null}
        <SettingsField label="Enabled" group>
          <label className="mc-next-settings-toggle">
            <input
              type="checkbox"
              checked={createForm.enabled}
              disabled={!isRuntimeInvokableMcpServer(createForm)}
              onChange={(event) => setCreateForm((current) => ({ ...current, enabled: event.target.checked }))}
            />
            <span>
              {isRuntimeInvokableMcpServer(createForm)
                ? "Enable immediately after create"
                : "Configured only until supported auth and URL are present"}
            </span>
          </label>
        </SettingsField>
      </SettingsFieldGrid>
      <section aria-label="MCP registration policy review">
        <h3>Saved authentication and policy</h3>
        <dl className="mc-next-settings-field-grid">
          <dt>Category</dt>
          <dd>{createForm.category.replaceAll("_", " ")}</dd>
          <dt>Trust</dt>
          <dd>{createForm.trustTier}</dd>
          <dt>Cost</dt>
          <dd>{createForm.costTier}</dd>
          <dt>Authentication</dt>
          <dd>
            {createForm.authType === "none"
              ? "None configured"
              : createForm.authType === "oauth2"
                ? "OAuth configuration only"
                : "Token environment references"}
          </dd>
          <dt>First tool approval</dt>
          <dd>
            {createForm.policy.requireFirstToolApproval ? "Required by server policy" : "Gateway policy still applies"}
          </dd>
          <dt>Redaction</dt>
          <dd>{createForm.policy.redactionMode}</dd>
          <dt>Allowed tool patterns</dt>
          <dd>{createForm.policy.allowedToolPatterns.join(", ") || "None recorded"}</dd>
          <dt>Blocked tool patterns</dt>
          <dd>{createForm.policy.blockedToolPatterns.join(", ") || "None recorded"}</dd>
          <dt>Environment key names</dt>
          <dd>{createForm.policy.allowedEnvKeys?.join(", ") || "None recorded"}</dd>
          {createForm.policy.notes ? (
            <>
              <dt>Policy note</dt>
              <dd>{createForm.policy.notes}</dd>
            </>
          ) : null}
        </dl>
        {createForm.oauth ? (
          <details>
            <summary>OAuth configuration references</summary>
            <dl>
              {Object.entries(createForm.oauth)
                .filter(([, value]) => value !== undefined)
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replace(/([A-Z])/g, " $1")}</dt>
                    <dd>
                      <code>{Array.isArray(value) ? value.join(", ") : String(value)}</code>
                    </dd>
                  </div>
                ))}
            </dl>
          </details>
        ) : null}
        <p className="mc-next-settings-field-note">
          Creating saves this configuration for the installation. It does not connect the server, launch its command,
          complete OAuth or grant tool access.
        </p>
      </section>
      <SettingsNotice
        notice={{
          tone: "info",
          message:
            "Runtime invocation supports local stdio, the built-in Approval Inbox, and governed remote http/sse servers with no auth, explicit token env-key policy, or connected OAuth token state.",
        }}
      />
      <SettingsButtonRow>
        <NativeButton variant="default" disabled={busy} onClick={() => void handleCreate()}>
          <Plus size={16} />
          Create MCP server
        </NativeButton>
      </SettingsButtonRow>
      {data.templates?.length ? (
        <SettingsActionList
          ariaLabel="MCP server templates"
          items={data.templates.map((item) => ({
            label: item.label,
            description: item.description,
            meta: item.installed ? "installed" : isRuntimeInvokableMcpServer(item) ? item.transport : "configured only",
            onClick: () => setCreateForm(createMcpFormFromTemplate(item)),
            actionLabel: "Use",
          }))}
        />
      ) : null}
    </SettingsStack>
  );
}
