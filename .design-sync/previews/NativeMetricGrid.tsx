import { NativeMetricGrid } from "@goatcitadel/mission-control-next";

export const Default = () => (
  <NativeMetricGrid
    items={[
      { label: "Active runs", value: "3", meta: "2 streaming" },
      { label: "Tokens today", value: "1.2M", meta: "$4.18" },
      { label: "Avg latency", value: "840ms" },
      { label: "Success rate", value: "98.6%", meta: "last 7d" },
    ]}
  />
);

export const TwoUp = () => (
  <NativeMetricGrid
    items={[
      { label: "Wards", value: "12" },
      { label: "Vaults", value: "4", meta: "all sealed" },
    ]}
  />
);
