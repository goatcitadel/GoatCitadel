import type {
  ChannelSetupFieldDefinition,
  ChannelSetupRichBlock,
  ChannelSetupTestResult,
  ChannelSetupValidationResult,
} from "@goatcitadel/contracts";
import { FieldHelp } from "../../components/FieldHelp";
import { Panel } from "../../components/Panel";
import { StatusChip } from "../../components/StatusChip";

export function FieldCard({
  field,
  value,
  hydrationState,
  onChange,
}: {
  field: ChannelSetupFieldDefinition;
  value: unknown;
  hydrationState?: "configured" | "missing" | "needs_replacement" | "unknown";
  onChange: (value: unknown) => void;
}) {
  const stringValue = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return (
    <div className="channel-setup-field-card">
      <div className="channel-setup-field-head">
        <label htmlFor={`channel-setup-${field.key}`}>
          <strong>{field.label}</strong>
          {field.required ? " *" : ""}
        </label>
        {field.sensitive ? <StatusChip tone="warning">Sensitive</StatusChip> : null}
      </div>
      <FieldHelp>{field.explanation}</FieldHelp>
      {field.whyNeeded ? (
        <FieldHelp>
          <strong>Why we need it:</strong> {field.whyNeeded}
        </FieldHelp>
      ) : null}
      <FieldInput field={field} value={stringValue} onChange={onChange} />
      {hydrationState === "configured" && !stringValue ? (
        <FieldHelp className="channel-setup-configured-note">
          Configured already. Enter a new value only if you need to replace it.
        </FieldHelp>
      ) : null}
      {field.whereToFind && field.whereToFind.length > 0 ? (
        <div className="channel-setup-field-meta">
          <strong>Where to find it</strong>
          {renderRichBlocks(field.whereToFind)}
        </div>
      ) : null}
      {field.looksLike ? (
        <div className="channel-setup-field-meta">
          <strong>What it should look like</strong>
          <code>{field.looksLike}</code>
        </div>
      ) : null}
      {field.commonMistakes && field.commonMistakes.length > 0 ? (
        <div className="channel-setup-field-meta">
          <strong>Common mistakes</strong>
          <ul className="channel-setup-inline-list">
            {field.commonMistakes.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {field.canChangeLater ? (
        <FieldHelp>You can update this later without recreating the entire connection.</FieldHelp>
      ) : null}
    </div>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ChannelSetupFieldDefinition;
  value: string;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "select") {
    return (
      <select
        id={`channel-setup-${field.key}`}
        value={value || String(field.defaultValue ?? "")}
        onChange={(event) => onChange(event.target.value)}
      >
        {!field.required ? <option value="">Select…</option> : null}
        {(field.options ?? []).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "boolean") {
    return (
      <label>
        <input
          id={`channel-setup-${field.key}`}
          type="checkbox"
          checked={value === "true"}
          onChange={(event) => onChange(event.target.checked)}
        />{" "}
        Enabled
      </label>
    );
  }

  if (field.type === "textarea") {
    return (
      <textarea
        id={`channel-setup-${field.key}`}
        className="full-textarea"
        rows={4}
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <input
      id={`channel-setup-${field.key}`}
      type={field.type === "secret" ? "password" : "text"}
      value={value}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function ResultPanel({
  title,
  result,
}: {
  title: string;
  result: ChannelSetupValidationResult | ChannelSetupTestResult;
}) {
  return (
    <Panel
      title={title}
      padding="compact"
      tone={result.status === "error" ? "critical" : result.status === "warn" ? "warning" : "accent"}
    >
      <div className="channel-setup-result-head">
        <StatusChip tone={result.status === "error" ? "critical" : result.status === "warn" ? "warning" : "success"}>
          {result.status}
        </StatusChip>
        <FieldHelp>Checked {new Date(result.checkedAt).toLocaleString()}</FieldHelp>
      </div>
      {result.issues.length === 0 ? (
        <FieldHelp>No issues found.</FieldHelp>
      ) : (
        <div className="stack-sm">
          {result.issues.map((issue) => (
            <div key={`${issue.key}-${issue.message}`} className="channel-setup-result-item">
              <strong>{issue.message}</strong>
              {issue.detail ? <FieldHelp>{issue.detail}</FieldHelp> : null}
              {issue.nextSteps && issue.nextSteps.length > 0 ? (
                <ul className="channel-setup-inline-list">
                  {issue.nextSteps.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {"recommendedNextAction" in result && result.recommendedNextAction ? (
        <FieldHelp>
          <strong>Next:</strong> {result.recommendedNextAction}
        </FieldHelp>
      ) : null}
      {"probe" in result && result.probe?.steps?.length ? (
        <div className="stack-sm">
          <FieldHelp>
            <strong>Probe truth</strong>
          </FieldHelp>
          <ul className="channel-setup-inline-list">
            {result.probe.steps.map((step) => (
              <li key={`${step.key}-${step.message}`}>
                <strong>{step.label}</strong> [{step.status}] {step.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}

export function renderRichBlocks(blocks?: ChannelSetupRichBlock[]) {
  if (!blocks || blocks.length === 0) {
    return null;
  }
  return (
    <div className="stack-sm">
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "paragraph") {
          return <p key={key}>{block.text}</p>;
        }
        if (block.kind === "list") {
          return block.ordered ? (
            <ol key={key} className="channel-setup-inline-list">
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>
          ) : (
            <ul key={key} className="channel-setup-inline-list">
              {block.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "note") {
          return (
            <div key={key} className={`channel-setup-note tone-${block.tone}`}>
              {block.title ? <strong>{block.title} </strong> : null}
              {block.text}
            </div>
          );
        }
        if (block.kind === "link") {
          return (
            <a
              key={key}
              href={block.href}
              target={block.external ? "_blank" : undefined}
              rel={block.external ? "noreferrer" : undefined}
            >
              {block.label}
            </a>
          );
        }
        return (
          <pre key={key}>
            <code>{block.code}</code>
          </pre>
        );
      })}
    </div>
  );
}
