export type OpenKind = "pointer" | "keyboard" | "programmatic";
export type DeferredOverlayInput<T> = {
  scopeKey: string;
  load: () => Promise<T>;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};
export type DeferredOverlayIntent<T, Owner> = {
  owner: Owner;
  kind: OpenKind;
  trigger: HTMLElement | null;
  origin: Element | null;
  pointerInFlight: boolean;
  runtime?: T;
  cancelled: boolean;
  restore: boolean;
  lastFocused: HTMLElement | null;
  unmounted: boolean;
};
export type DeferredOverlayReloadReview<T, Owner> = {
  ticket: DeferredOverlayIntent<T, Owner>;
  history: string;
  url: string;
  button: HTMLButtonElement;
};
export function createDeferredOverlayOwner<Citadel, Workspace>(
  gateway: string,
  caller: number,
  access: number,
  location: number,
  citadel: Citadel,
  workspace: Workspace,
  scopeKey: string,
) {
  return { gateway, caller, access, location, citadel, workspace, scopeKey };
}
