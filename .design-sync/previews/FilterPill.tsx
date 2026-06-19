import { FilterPill } from "@goatcitadel/mission-control-next";

const row = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" } as const;
const noop = () => {};

export const States = () => (
  <div style={row}>
    <FilterPill label="All" selected tabIndex={0} onSelect={noop} count={128} />
    <FilterPill label="Knowledge" selected={false} tabIndex={-1} onSelect={noop} count={42} />
    <FilterPill label="Tasks" selected={false} tabIndex={-1} onSelect={noop} count={7} />
  </div>
);

export const NoCount = () => (
  <div style={row}>
    <FilterPill label="Active" selected tabIndex={0} onSelect={noop} />
    <FilterPill label="Archived" selected={false} tabIndex={-1} onSelect={noop} />
  </div>
);
