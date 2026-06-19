# GoatCitadel Mission Control — usage conventions

This is the **native primitive kit** of mission-control-next. The components are styled with bespoke CSS + design tokens — **not Tailwind, not utility classes**. Build with them as follows.

## Theme wrapper (required)

Every component reads CSS custom properties declared on a **theme class**. Put one on a high-level container (your app shell or `<body>`):

- `theme-citadel-light` — the warm "Citadel Light" theme (what these previews use)
- `theme-signal-noir` — the dark theme

```jsx
<div className="theme-citadel-light">{/* your screen */}</div>
```

Without a `.theme-*` ancestor, components render with missing colors. Optionally also set `data-area="chat|cowork|code|projects|library|ops|settings"` on a container — area-accented components (StageHeader, ContextStrip, rails) tint to that area's hue.

## Styling idiom — tokens + props, never utility classes

There is **no className utility vocabulary** (`bg-*`, `p-*`, `flex`, …) — Tailwind is not compiled here, so utility classes do nothing. Style two ways:

1. **Configure components through their typed props** — `variant`, `tone`, `size`, `area`, `mode`, … (see each `<Name>.d.ts`). Components apply their own internal classes; never hand-write their markup.
2. **For your own layout/wrappers, use the CSS variables** via `var(--token)`.

| Family | Tokens |
|---|---|
| Surfaces | `--bg-app`, `--bg-surface-1`, `--bg-surface-2`, `--bg-surface-3` |
| Text | `--fg-primary`, `--fg-secondary`, `--fg-muted` |
| Borders | `--border-subtle`, `--border-default`, `--border-strong` |
| Semantic aliases | `--background`, `--foreground`, `--card`, `--muted`, `--primary`, `--border` |
| Area accents | `--area-chat`, `--area-cowork`, `--area-code`, `--area-projects`, `--area-library`, `--area-ops`, `--area-settings` |
| Risk tones | `--risk-safe`, `--risk-caution`, `--risk-danger`, `--risk-nuclear` |
| Radii | `--r-xs`, `--r-sm`, `--r-md`, `--r-lg`, `--r-pill` |
| Type scale | `--text-2xs`, `--text-xs`, `--text-sm`, `--text-md`, `--text-lg` |
| Fonts | `--font-sans` (Geist Variable), `--font-mono` |

Convention: "chrome" labels (eyebrows, kickers, status strips) use `--font-mono`, uppercase, letter-spaced; body copy uses `--font-sans`.

## Where the truth lives

- **`styles.css`** (and its `@import "./_ds_bundle.css"`) — the full token list + component CSS. Read it before styling.
- **`<Name>.d.ts`** — the component's typed API. **`<Name>.prompt.md`** — usage notes + examples.

## Idiomatic example

```jsx
<div className="theme-citadel-light" data-area="cowork"
     style={{ padding: 24, background: "var(--bg-app)", color: "var(--fg-primary)" }}>
  <StageHeader
    area="cowork"
    eyebrow="Cowork"
    title="Task workspace"
    description="Plan, run, and review agent tasks."
    metrics={[{ label: "Active", value: "3" }, { label: "Queued", value: "8", delta: { value: "+2", tone: "up" } }]}
    actions={<NativeButton variant="default">New task</NativeButton>}
  />
  <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
    <NativeSelectableList
      ariaLabel="Projects"
      selectedId="citadel"
      items={[
        { id: "citadel", title: "Citadel", meta: "active", body: "Founder/operator control plane." },
        { id: "gateway", title: "Gateway", meta: "12 routes" },
      ]}
    />
    <StatusChip tone="success">Operational</StatusChip>
  </div>
</div>
```

Components in this kit: NativeButton, StatusChip, ThreePartChip, StageHeader, EmptyState, ErrorState, ContextStrip, FilterPill, FilterPillGroup, ModeBar, NativeMetricGrid, NativeSelectableList, KbdHint.
