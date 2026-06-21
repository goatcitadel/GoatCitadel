// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeTable, type NativeTableColumn } from "./NativeTable";

type Row = { id: string; provider: string; tokens: string; cost: string };

const columns: NativeTableColumn<Row>[] = [
  { key: "provider", header: "Provider", cell: (r) => r.provider },
  { key: "tokens", header: "Tokens", numeric: true, cell: (r) => r.tokens },
  { key: "cost", header: "Cost", numeric: true, cell: (r) => r.cost },
];

const rows: Row[] = [
  { id: "anthropic", provider: "Anthropic", tokens: "1,200,000", cost: "$7.10" },
  { id: "openai", provider: "OpenAI", tokens: "640,000", cost: "$3.80" },
];

describe("NativeTable", () => {
  it("renders a semantic table with a scoped column header per column", () => {
    const markup = renderToStaticMarkup(
      <NativeTable ariaLabel="Provider spend" columns={columns} rows={rows} getRowKey={(r) => r.id} />,
    );
    expect(markup).toContain("<table");
    expect(markup).toContain('aria-label="Provider spend"');
    expect(markup).toContain('scope="col"');
    expect(markup).toContain("Provider");
    expect(markup).toContain("Tokens");
    expect(markup).toContain("Anthropic");
    expect(markup).toContain("$7.10");
  });

  it("marks numeric columns end-aligned and tabular in both header and body", () => {
    const markup = renderToStaticMarkup(
      <NativeTable ariaLabel="Provider spend" columns={columns} rows={rows} getRowKey={(r) => r.id} />,
    );
    expect(markup).toContain('data-numeric="true"');
    expect(markup).toContain('data-align="end"');
  });

  it("renders the empty state instead of a table when there are no rows", () => {
    const markup = renderToStaticMarkup(
      <NativeTable ariaLabel="Empty" columns={columns} rows={[]} getRowKey={(r) => r.id} emptyLabel="No spend yet." />,
    );
    expect(markup).not.toContain("<table");
    expect(markup).toContain("No spend yet.");
  });

  it("prefers render over cell for custom cell content", () => {
    const markup = renderToStaticMarkup(
      <NativeTable
        ariaLabel="Custom"
        columns={[{ key: "p", header: "Provider", render: (r) => <span className="tag">{r.provider}</span> }]}
        rows={rows}
        getRowKey={(r) => r.id}
      />,
    );
    expect(markup).toContain('class="tag"');
  });

  it("emits the sticky-head class by default and omits it when disabled", () => {
    const sticky = renderToStaticMarkup(
      <NativeTable ariaLabel="t" columns={columns} rows={rows} getRowKey={(r) => r.id} />,
    );
    expect(sticky).toContain("has-sticky-head");
    const flat = renderToStaticMarkup(
      <NativeTable ariaLabel="t" columns={columns} rows={rows} getRowKey={(r) => r.id} stickyHeader={false} />,
    );
    expect(flat).not.toContain("has-sticky-head");
  });
});
