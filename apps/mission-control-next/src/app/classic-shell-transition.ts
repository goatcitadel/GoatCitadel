import { openApplicationShell, type ShellTransitionOptions } from "./shell-transition";
export type ClassicShellTransitionOptions = ShellTransitionOptions;
/** Compatibility facade for existing exact classic-owner links. */
export function openClassicShell(href: string, options: ClassicShellTransitionOptions) {
  return openApplicationShell("classic", href, options);
}
