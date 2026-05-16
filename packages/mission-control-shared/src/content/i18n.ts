type I18nParams = Readonly<Record<string, string | number>>;

type BundleEntry = (params: I18nParams) => string;

const ENGLISH: Readonly<Record<string, BundleEntry>> = Object.freeze({
  "shell.summary.empty": () => "Empty shell command",
  "shell.summary.unparsed": () => "Unparsed shell command",
  "shell.summary.generic": ({ program, count }) => `Run ${program} with ${count} argument${count === 1 ? "" : "s"}`,

  "shell.action.git_push": () => "git push",
  "shell.action.git_reset": () => "git reset",
  "shell.action.rm": () => "rm",
  "shell.action.curl": () => "curl",
  "shell.action.wget": () => "wget",
  "shell.action.pnpm_install": () => "pnpm install",
  "shell.action.npm_install": () => "npm install",
  "shell.action.yarn_install": () => "yarn install",
  "shell.action.sudo": () => "sudo",
  "shell.action.chmod": () => "chmod",
  "shell.action.mv": () => "mv",
  "shell.action.ssh": () => "ssh",

  "shell.detail.action": () => "Action",
  "shell.detail.target": () => "Target",
  "shell.detail.force": () => "Force",
  "shell.detail.recursive": () => "Recursive",
  "shell.detail.url": () => "URL",
  "shell.detail.scope": () => "Scope",
  "shell.detail.flags": () => "Flags",
  "shell.detail.host": () => "Host",
  "shell.detail.mode": () => "Mode",
  "shell.detail.source": () => "Source",
  "shell.detail.destination": () => "Destination",

  "shell.git_push.force_summary": ({ branch, remote }) => `Force-push branch '${branch}' to remote '${remote}'`,
  "shell.git_push.force_with_lease_summary": ({ branch, remote }) =>
    `Force-push (with lease) branch '${branch}' to remote '${remote}'`,
  "shell.git_push.normal_summary": ({ branch, remote }) => `Push branch '${branch}' to remote '${remote}'`,
  "shell.git_reset.hard_summary": ({ target }) => `Discard work and reset to ${target}`,

  "shell.rm.recursive_summary": ({ target }) => `Recursively delete ${target}`,
  "shell.rm.root_summary": () => "Recursively delete from filesystem root",

  "shell.curl.pipe_summary": ({ url }) => `Download ${url} and execute as shell script`,
  "shell.curl.fetch_summary": ({ url }) => `Fetch ${url}`,

  "shell.pnpm.install_summary": () => "Install workspace dependencies",
  "shell.pnpm.add_summary": ({ packages }) => `Install npm package ${packages}`,

  "shell.ssh.summary": ({ host }) => `Open shell on ${host}`,
  "shell.chmod.summary": ({ mode, target }) => `Set permissions ${mode} on ${target}`,
  "shell.mv.summary": ({ source, destination }) => `Rename ${source} to ${destination}`,

  "shell.risk.force_push.label": () => "Force-push",
  "shell.risk.force_push.explanation": () => "rewrites remote branch history",
  "shell.risk.force_with_lease.label": () => "Force-push with lease",
  "shell.risk.force_with_lease.explanation": () => "rewrites remote branch history; lease still allows destruction",
  "shell.risk.hard_reset.label": () => "Hard reset",
  "shell.risk.hard_reset.explanation": () => "discards uncommitted work",
  "shell.risk.recursive_delete.label": () => "Recursive delete",
  "shell.risk.recursive_delete.explanation": () => "deletes directories",
  "shell.risk.force_delete.label": () => "Force delete",
  "shell.risk.force_delete.explanation": () => "no confirmation, ignores missing",
  "shell.risk.filesystem_root.label": () => "Filesystem root",
  "shell.risk.filesystem_root.explanation": () => "deletes from filesystem root",
  "shell.risk.pipe_to_shell.label": () => "Pipe-to-shell",
  "shell.risk.pipe_to_shell.explanation": () => "executes remote content as a shell script",
  "shell.risk.insecure_tls.label": () => "Skip TLS verification",
  "shell.risk.insecure_tls.explanation": () => "ignores certificate validity",
  "shell.risk.global_install.label": () => "Global install",
  "shell.risk.global_install.explanation": () => "modifies system-wide packages",
  "shell.risk.sudo.label": () => "Sudo",
  "shell.risk.sudo.explanation": () => "runs as root",
  "shell.risk.world_writable.label": () => "World-writable",
  "shell.risk.world_writable.explanation": () => "any user can read, write, and execute",
  "shell.risk.system_path_write.label": () => "System path write",
  "shell.risk.system_path_write.explanation": () => "overwrites system file",
  "shell.risk.root_login.label": () => "Root login",
  "shell.risk.root_login.explanation": () => "interactive shell as root",
});

export type I18nKey = keyof typeof ENGLISH;

export function t(key: I18nKey, params: I18nParams = {}): string {
  const entry = ENGLISH[key];
  if (!entry) {
    return key;
  }
  return entry(params);
}
