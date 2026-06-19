import { NativeButton } from "@goatcitadel/mission-control-next";
import { Plus, Trash2 } from "lucide-react";

const row = { display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" } as const;
const icon = { width: 14, height: 14 } as const;

export const Variants = () => (
  <div style={row}>
    <NativeButton variant="default">Save changes</NativeButton>
    <NativeButton variant="outline">Cancel</NativeButton>
    <NativeButton variant="secondary">Secondary</NativeButton>
    <NativeButton variant="ghost">Ghost</NativeButton>
    <NativeButton variant="destructive">Delete</NativeButton>
  </div>
);

export const WithIcons = () => (
  <div style={row}>
    <NativeButton variant="default">
      <Plus style={icon} /> New task
    </NativeButton>
    <NativeButton variant="destructive">
      <Trash2 style={icon} /> Remove
    </NativeButton>
  </div>
);

export const Disabled = () => (
  <div style={row}>
    <NativeButton variant="default" disabled>
      Saving…
    </NativeButton>
    <NativeButton variant="outline" disabled>
      Cancel
    </NativeButton>
  </div>
);
