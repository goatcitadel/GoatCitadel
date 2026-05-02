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
  if (field.key === "targets") {
    return <TargetListFieldCard field={field} value={value} hydrationState={hydrationState} onChange={onChange} />;
  }
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

function TargetListFieldCard({
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
  const targets = normalizeTargetRows(value);
  const addressKey = field.label.toLowerCase().includes("telegram") ? "chatId" : "channel";
  const addressLabel = addressKey === "chatId" ? "Chat ID or @channel" : "Channel name or ID";
  const defaultIndex = Math.max(
    0,
    targets.findIndex((target) => target.default === true),
  );
  const updateTarget = (index: number, patch: Record<string, unknown>) => {
    onChange(targets.map((target, targetIndex) => (targetIndex === index ? { ...target, ...patch } : target)));
  };
  const removeTarget = (index: number) => {
    const next = targets.filter((_, targetIndex) => targetIndex !== index);
    onChange(next.map((target, targetIndex) => ({ ...target, default: targetIndex === 0 })));
  };
  const addTarget = () => {
    onChange([
      ...targets,
      {
        id: `target-${targets.length + 1}`,
        label: "",
        [addressKey]: "",
        default: targets.length === 0,
      },
    ]);
  };
  return (
    <div className="channel-setup-field-card">
      <div className="channel-setup-field-head">
        <label>
          <strong>{field.label}</strong>
          {field.required ? " *" : ""}
        </label>
      </div>
      <FieldHelp>{field.explanation}</FieldHelp>
      {field.whyNeeded ? (
        <FieldHelp>
          <strong>Why we need it:</strong> {field.whyNeeded}
        </FieldHelp>
      ) : null}
      <div className="channel-setup-target-list">
        {targets.map((target, index) => (
          <div key={`${target.id}-${index}`} className="channel-setup-target-row">
            <input
              aria-label="Target label"
              value={target.label}
              placeholder="Label"
              onChange={(event) => updateTarget(index, { label: event.target.value })}
            />
            <input
              aria-label={addressLabel}
              value={target[addressKey] ?? ""}
              placeholder={addressLabel}
              onChange={(event) => updateTarget(index, { [addressKey]: event.target.value })}
            />
            <label className="channel-setup-target-default">
              <input
                type="radio"
                name={`channel-setup-${field.key}-default`}
                checked={index === defaultIndex}
                onChange={() => onChange(targets.map((item, itemIndex) => ({ ...item, default: itemIndex === index })))}
              />
              Default
            </label>
            <button type="button" className="gc-button" onClick={() => removeTarget(index)}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="gc-button" onClick={addTarget}>
        Add target
      </button>
      {hydrationState === "configured" && targets.length === 0 ? (
        <FieldHelp className="channel-setup-configured-note">
          Targets are configured already. Add a row only if you need to replace or expand them.
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
    </div>
  );
}

function normalizeTargetRows(value: unknown) {
  const parsed = typeof value === "string" ? parseTargetRows(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item, index) => ({
      id: readString(item.id) || `target-${index + 1}`,
      label: readString(item.label),
      channel: readString(item.channel),
      chatId: readString(item.chatId),
      default: item.default === true || item.default === "true" || index === 0,
      kind: readString(item.kind),
    }));
}

function parseTargetRows(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
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
