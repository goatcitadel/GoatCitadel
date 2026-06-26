import { createParser, type ParseResult } from "@openuidev/lang-core";
import { createLibrary, defineComponent, Renderer } from "@openuidev/react-lang";
import { z } from "zod/v4";

export type OpenUiStructuredComponentName =
  | "StatusCard"
  | "MetricStrip"
  | "StepList"
  | "KeyValueGrid"
  | "ActionChips"
  | "MiniTable";

export interface OpenUiStructuredBlock {
  kind: "openui";
  source: string;
  components: readonly OpenUiStructuredComponentName[];
}

export type GeneratedUiBlock = OpenUiStructuredBlock;

const toneSchema = z.enum(["neutral", "info", "success", "warning", "critical"]).default("neutral");

const StatusCard = defineComponent({
  name: "StatusCard",
  description: "A compact runtime or answer status card.",
  props: z.object({
    title: z.string().min(1).max(96),
    status: z.enum(["info", "success", "warning", "critical"]).default("info"),
    body: z.string().max(360).optional(),
    details: z.array(z.string().min(1).max(120)).max(4).optional(),
  }),
  component: ({ props }) => {
    const { title, status, body, details } = props;
    return (
      <section className={`gc-openui-block gc-openui-status tone-${status}`} aria-label={title}>
        <div>
          <span className="gc-openui-kicker">{status}</span>
          <strong>{title}</strong>
        </div>
        {body ? <p>{body}</p> : null}
        {details?.length ? (
          <ul>
            {details.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : null}
      </section>
    );
  },
});

const MetricStrip = defineComponent({
  name: "MetricStrip",
  description: "A strip of compact labelled metrics.",
  props: z.object({
    metrics: z
      .array(
        z.object({
          label: z.string().min(1).max(48),
          value: z.string().min(1).max(48),
          detail: z.string().max(96).optional(),
          tone: toneSchema,
        }),
      )
      .min(1)
      .max(6),
  }),
  component: ({ props }) => (
    <div className="gc-openui-block gc-openui-metric-strip" aria-label="Generated metrics">
      {props.metrics.map((metric) => (
        <div key={`${metric.label}-${metric.value}`} className={`tone-${metric.tone}`}>
          <span>{metric.label}</span>
          <strong>{metric.value}</strong>
          {metric.detail ? <small>{metric.detail}</small> : null}
        </div>
      ))}
    </div>
  ),
});

const StepList = defineComponent({
  name: "StepList",
  description: "A short ordered list of task or workflow steps.",
  props: z.object({
    title: z.string().min(1).max(80).optional(),
    steps: z
      .array(
        z.object({
          label: z.string().min(1).max(96),
          status: z.enum(["pending", "active", "done", "blocked"]).default("pending"),
          detail: z.string().max(180).optional(),
        }),
      )
      .min(1)
      .max(8),
  }),
  component: ({ props }) => (
    <section className="gc-openui-block gc-openui-step-list" aria-label={props.title ?? "Generated steps"}>
      {props.title ? <strong>{props.title}</strong> : null}
      <ol>
        {props.steps.map((step, index) => (
          <li key={`${step.label}-${index}`} className={`tone-${step.status}`}>
            <span>{step.status}</span>
            <div>
              <strong>{step.label}</strong>
              {step.detail ? <p>{step.detail}</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  ),
});

const KeyValueGrid = defineComponent({
  name: "KeyValueGrid",
  description: "A compact key/value grid for runtime facts or settings.",
  props: z.object({
    items: z
      .array(
        z.object({
          label: z.string().min(1).max(56),
          value: z.string().min(1).max(140),
        }),
      )
      .min(1)
      .max(10),
  }),
  component: ({ props }) => (
    <dl className="gc-openui-block gc-openui-kv-grid">
      {props.items.map((item) => (
        <div key={`${item.label}-${item.value}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  ),
});

const ActionChips = defineComponent({
  name: "ActionChips",
  description: "Non-interactive chips that summarize possible next actions.",
  props: z.object({
    actions: z
      .array(
        z.object({
          label: z.string().min(1).max(64),
          tone: toneSchema,
        }),
      )
      .min(1)
      .max(8),
  }),
  component: ({ props }) => (
    <div className="gc-openui-block gc-openui-action-chips" role="list" aria-label="Generated action chips">
      {props.actions.map((action) => (
        <span key={action.label} role="listitem" className={`tone-${action.tone}`}>
          {action.label}
        </span>
      ))}
    </div>
  ),
});

const MiniTable = defineComponent({
  name: "MiniTable",
  description: "A small read-only table for compact comparisons.",
  props: z.object({
    caption: z.string().max(80).optional(),
    columns: z.array(z.string().min(1).max(48)).min(1).max(5),
    rows: z
      .array(z.array(z.string().max(96)).min(1).max(5))
      .min(1)
      .max(6),
  }),
  component: ({ props }) => (
    <div className="gc-openui-block gc-openui-mini-table">
      <table>
        {props.caption ? <caption>{props.caption}</caption> : null}
        <thead>
          <tr>
            {props.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {props.columns.map((column, columnIndex) => (
                <td key={`${column}-${columnIndex}`}>{row[columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ),
});

const GOAT_OPENUI_COMPONENTS = [StatusCard, MetricStrip, StepList, KeyValueGrid, ActionChips, MiniTable];

const goatOpenUiLibrary = createLibrary({
  components: GOAT_OPENUI_COMPONENTS,
});

const goatOpenUiParser = createParser(goatOpenUiLibrary.toJSONSchema());

export const GOAT_OPENUI_COMPONENT_NAMES: OpenUiStructuredComponentName[] = [
  "StatusCard",
  "MetricStrip",
  "StepList",
  "KeyValueGrid",
  "ActionChips",
  "MiniTable",
];

export function isGoatOpenUiRendererEnabled(): boolean {
  const globalFlag = globalThis.__GOATCITADEL_OPENUI_RENDERER__;
  if (globalFlag !== undefined) {
    return globalFlag === true || globalFlag === "true";
  }
  return import.meta.env.VITE_GOATCITADEL_OPENUI_RENDERER === "true";
}

export function parseOpenUiStructuredBlock(source: string): ParseResult | null {
  try {
    return goatOpenUiParser.parse(source.trim());
  } catch {
    return null;
  }
}

export function canRenderOpenUiStructuredBlock(source: string): boolean {
  const result = parseOpenUiStructuredBlock(source);
  return Boolean(
    result?.root &&
    !result.meta.incomplete &&
    result.meta.unresolved.length === 0 &&
    result.meta.errors.length === 0 &&
    result.queryStatements.length === 0 &&
    result.mutationStatements.length === 0,
  );
}

export function OpenUiStructuredBlockRenderer({ source }: { source: string }) {
  return (
    <div className="gc-openui-renderer" data-openui-components={GOAT_OPENUI_COMPONENT_NAMES.join(",")}>
      <Renderer response={source.trim()} library={goatOpenUiLibrary} isStreaming={false} toolProvider={null} />
    </div>
  );
}
