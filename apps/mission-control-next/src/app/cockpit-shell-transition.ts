import { openApplicationShell, type ShellTransitionOptions } from "./shell-transition";
/** Explicit reverse handoff; scoped owner links are validated by their caller. */
export function openCockpitShell(href: string, options: ShellTransitionOptions) {
  return openApplicationShell("cockpit", href, options);
}
