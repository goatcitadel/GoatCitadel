import { NativeSelectableList } from "@goatcitadel/mission-control-next";

const noop = () => {};

export const Default = () => (
  <NativeSelectableList
    ariaLabel="Projects"
    selectedId="citadel"
    onSelect={noop}
    items={[
      { id: "citadel", title: "Citadel", meta: "active", body: "Founder/operator control plane." },
      { id: "gateway", title: "Gateway", meta: "12 routes", body: "Runtime + policy engine." },
      { id: "memory", title: "Memory core", meta: "3 namespaces", body: "Threaded recall + vault." },
    ]}
  />
);

export const Empty = () => <NativeSelectableList ariaLabel="Projects" emptyLabel="No projects yet." />;
