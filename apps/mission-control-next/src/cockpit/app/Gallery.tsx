import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/Menu";
import { Sheet } from "../ui/Sheet";
import { Skeleton } from "../ui/Skeleton";
import { StatusBadge } from "../ui/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/Tabs";
import { Tooltip } from "../ui/Tooltip";

const STATUSES = [
  { label: "Running", tone: "running" },
  { label: "Waiting on you", tone: "waiting" },
  { label: "Paused", tone: "neutral" },
  { label: "Done", tone: "done" },
  { label: "Failed", tone: "failed" },
] as const;

/** Interactive primitive gallery for both theme states; no runtime mutations. */
export function Gallery() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { theme, setTheme } = useUiPreferences();
  return <div className="flex flex-col gap-8 p-6" data-cockpit-gallery="true">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="font-display text-xl text-fg">Cockpit components</h1><p className="text-sm text-fg-secondary">Interactive design review</p></div>
      <Button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>Preview {theme === "dark" ? "light" : "dark"} theme</Button>
    </header>
    <section aria-label="Buttons" className="flex flex-wrap gap-2">
      <Button variant="primary">Primary</Button><Button>Secondary</Button><Button variant="ghost">Ghost</Button>
      <Button variant="danger">Danger</Button><Button disabled>Unavailable</Button><Button size="sm">Small</Button>
      <Tooltip label="More options"><IconButton label="More options" icon={<MoreHorizontal aria-hidden="true" className="size-4" />} /></Tooltip>
    </section>
    <section aria-label="Status and shortcuts" className="flex flex-wrap items-center gap-2">
      {STATUSES.map((status) => <StatusBadge key={status.label} status={status} />)}<Kbd>Ctrl K</Kbd>
    </section>
    <section aria-label="Menus and overlays" className="flex flex-wrap gap-2">
      <Menu><MenuTrigger className="rounded-md border border-line px-3 py-2 text-sm">Open menu</MenuTrigger>
        <MenuContent><MenuItem>First action</MenuItem><MenuItem>Second action</MenuItem></MenuContent></Menu>
      <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
      <Button onClick={() => setSheetOpen(true)}>Open sheet</Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} title="Example dialog" description="A focused decision surface."><p className="text-sm text-fg-secondary">Dialog content</p></Dialog>
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title="Example sheet"><p className="text-sm text-fg-secondary">Sheet content</p></Sheet>
    </section>
    <section aria-label="Tabs"><Tabs defaultValue="run"><TabsList><TabsTrigger value="run">Run</TabsTrigger><TabsTrigger value="turn">Turn</TabsTrigger></TabsList>
      <TabsContent value="run" className="p-3 text-sm text-fg-secondary">Run details</TabsContent><TabsContent value="turn" className="p-3 text-sm text-fg-secondary">Turn details</TabsContent>
    </Tabs></section>
    <section aria-label="Loading" className="flex flex-col gap-2"><Skeleton className="h-4 w-64" /><Skeleton className="h-4 w-40" /></section>
    <EmptyState title="Nothing waiting on you" description="New decisions appear here." action={<Button>Open Chat</Button>} />
  </div>;
}
