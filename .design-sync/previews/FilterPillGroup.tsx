import { FilterPillGroup } from "@goatcitadel/mission-control-next";

const noop = () => {};

export const Default = () => (
  <FilterPillGroup
    label="Memory namespace filter"
    value="all"
    onChange={noop}
    options={[
      { value: "all", label: "All", count: 128 },
      { value: "knowledge", label: "Knowledge", count: 42 },
      { value: "tasks", label: "Tasks", count: 7 },
      { value: "archived", label: "Archived", count: 19 },
    ]}
  />
);

export const Compact = () => (
  <FilterPillGroup
    label="Run status filter"
    value="active"
    onChange={noop}
    options={[
      { value: "active", label: "Active" },
      { value: "done", label: "Done" },
      { value: "failed", label: "Failed" },
    ]}
  />
);
