import { t, type I18nKey } from "./i18n.js";
import type { ShellRiskFinding, ShellRiskLevel } from "./shell-command-prescreen.js";

export interface ShellExplanationDetail {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
  readonly noteLevel?: ShellRiskLevel;
}

export interface HandlerResult {
  readonly program: string;
  readonly summary: string;
  readonly details: readonly ShellExplanationDetail[];
  readonly risks: readonly ShellRiskFinding[];
}

type Tokens = readonly string[];
type Handler = (tokens: Tokens) => HandlerResult;

function isFlag(token: string): boolean {
  return token.startsWith("-");
}

function nonFlagTokens(tokens: Tokens): string[] {
  return tokens.filter((t) => !isFlag(t));
}

function findFlag(tokens: Tokens, ...candidates: string[]): boolean {
  return tokens.some((tk) => candidates.includes(tk));
}

function findCombinedShortFlag(tokens: Tokens, char: string): boolean {
  return tokens.some((tk) => /^-[a-zA-Z]+$/.test(tk) && tk.includes(char));
}

function risk(level: ShellRiskLevel, labelKey: I18nKey, explanationKey: I18nKey): ShellRiskFinding {
  return {
    level,
    label: t(labelKey),
    explanation: t(explanationKey),
  };
}

const gitPush: Handler = (tokens) => {
  const flagsAfter = tokens.slice(2);
  const force = findFlag(flagsAfter, "--force", "-f");
  const forceLease = findFlag(flagsAfter, "--force-with-lease");
  const positional = nonFlagTokens(flagsAfter);
  const remote = positional[0] ?? "origin";
  const branch = positional[1] ?? "current branch";

  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: t("shell.action.git_push") },
    { label: t("shell.detail.target"), value: `branch '${branch}' on remote '${remote}'` },
  ];
  if (forceLease) {
    details.push({
      label: t("shell.detail.force"),
      value: "true",
      note: t("shell.risk.force_with_lease.explanation"),
      noteLevel: "danger",
    });
  } else if (force) {
    details.push({
      label: t("shell.detail.force"),
      value: "true",
      note: t("shell.risk.force_push.explanation"),
      noteLevel: "danger",
    });
  }

  const risks: ShellRiskFinding[] = [];
  if (forceLease) {
    risks.push(risk("danger", "shell.risk.force_with_lease.label", "shell.risk.force_with_lease.explanation"));
  } else if (force) {
    risks.push(risk("danger", "shell.risk.force_push.label", "shell.risk.force_push.explanation"));
  }

  const summaryKey = forceLease
    ? ("shell.git_push.force_with_lease_summary" as const)
    : force
      ? ("shell.git_push.force_summary" as const)
      : ("shell.git_push.normal_summary" as const);
  return {
    program: "git",
    summary: t(summaryKey, { branch, remote }),
    details,
    risks,
  };
};

const gitReset: Handler = (tokens) => {
  const flagsAfter = tokens.slice(2);
  const hard = findFlag(flagsAfter, "--hard");
  const positional = nonFlagTokens(flagsAfter);
  const target = positional[0] ?? "HEAD";
  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: t("shell.action.git_reset") },
    { label: t("shell.detail.target"), value: target },
  ];
  const risks: ShellRiskFinding[] = [];
  if (hard) {
    details.push({
      label: t("shell.detail.mode"),
      value: "--hard",
      note: t("shell.risk.hard_reset.explanation"),
      noteLevel: "danger",
    });
    risks.push(risk("danger", "shell.risk.hard_reset.label", "shell.risk.hard_reset.explanation"));
  }
  return {
    program: "git",
    summary: hard ? t("shell.git_reset.hard_summary", { target }) : `git reset to ${target}`,
    details,
    risks,
  };
};

const genericGit: Handler = (tokens) => ({
  program: "git",
  summary: `git ${tokens.slice(1).join(" ")}`,
  details: [{ label: t("shell.detail.action"), value: `git ${tokens[1] ?? ""}`.trim() }],
  risks: [],
});

const git: Handler = (tokens) => {
  const sub = tokens[1];
  if (sub === "push") return gitPush(tokens);
  if (sub === "reset") return gitReset(tokens);
  return genericGit(tokens);
};

const rm: Handler = (tokens) => {
  const after = tokens.slice(1);
  const recursive =
    findFlag(after, "-r", "-R", "--recursive") ||
    findCombinedShortFlag(after, "r") ||
    findCombinedShortFlag(after, "R");
  const force = findFlag(after, "-f", "--force") || findCombinedShortFlag(after, "f");
  const targets = nonFlagTokens(after);

  const details: ShellExplanationDetail[] = [{ label: t("shell.detail.action"), value: t("shell.action.rm") }];
  const risks: ShellRiskFinding[] = [];
  if (recursive) {
    details.push({
      label: t("shell.detail.recursive"),
      value: "true",
      note: t("shell.risk.recursive_delete.explanation"),
      noteLevel: "danger",
    });
    risks.push(risk("danger", "shell.risk.recursive_delete.label", "shell.risk.recursive_delete.explanation"));
  }
  if (force) {
    details.push({
      label: t("shell.detail.force"),
      value: "true",
      note: t("shell.risk.force_delete.explanation"),
      noteLevel: "danger",
    });
    risks.push(risk("danger", "shell.risk.force_delete.label", "shell.risk.force_delete.explanation"));
  }
  for (const target of targets) {
    details.push({ label: t("shell.detail.target"), value: target });
    if (target === "/") {
      risks.push(risk("danger", "shell.risk.filesystem_root.label", "shell.risk.filesystem_root.explanation"));
    }
  }

  const summary = recursive
    ? targets[0] === "/"
      ? t("shell.rm.root_summary")
      : t("shell.rm.recursive_summary", { target: targets.join(" ") || "(no target)" })
    : `Delete ${targets.join(" ") || "(no target)"}`;

  return { program: "rm", summary, details, risks };
};

const curlOrWget: Handler = (tokens) => {
  const program = tokens[0] ?? "curl";
  const after = tokens.slice(1);
  const insecure = findFlag(after, "-k", "--insecure");
  const url = after.find((tk) => /^https?:\/\//.test(tk)) ?? "(no URL)";
  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: program },
    { label: t("shell.detail.url"), value: url },
  ];
  const risks: ShellRiskFinding[] = [];
  if (insecure) {
    risks.push(risk("caution", "shell.risk.insecure_tls.label", "shell.risk.insecure_tls.explanation"));
  }
  return {
    program,
    summary: t("shell.curl.fetch_summary", { url }),
    details,
    risks,
  };
};

const packageManager: Handler = (tokens) => {
  const program = tokens[0] ?? "npm";
  const sub = tokens[1];
  const after = tokens.slice(2);
  const global = findFlag(after, "--global", "-g");
  const positional = nonFlagTokens(after);

  const details: ShellExplanationDetail[] = [
    { label: t("shell.detail.action"), value: `${program} ${sub ?? ""}`.trim() },
  ];
  const risks: ShellRiskFinding[] = [];

  if (sub === "install" && positional.length === 0) {
    return {
      program,
      summary: t("shell.pnpm.install_summary"),
      details: [...details, { label: t("shell.detail.scope"), value: "all workspace dependencies (no package args)" }],
      risks,
    };
  }
  if (sub === "add" || (sub === "install" && positional.length > 0)) {
    if (global) {
      risks.push(risk("caution", "shell.risk.global_install.label", "shell.risk.global_install.explanation"));
      details.push({
        label: t("shell.detail.scope"),
        value: "global",
        note: t("shell.risk.global_install.explanation"),
        noteLevel: "caution",
      });
    }
    return {
      program,
      summary: t("shell.pnpm.add_summary", { packages: positional.join(", ") }),
      details,
      risks,
    };
  }

  return {
    program,
    summary: `Run ${program} ${tokens.slice(1).join(" ")}`,
    details,
    risks,
  };
};

const ssh: Handler = (tokens) => {
  const after = tokens.slice(1);
  const target = after.find((tk) => !isFlag(tk)) ?? "(no host)";
  const isRoot = target.startsWith("root@");
  const risks: ShellRiskFinding[] = [];
  if (isRoot) {
    risks.push(risk("caution", "shell.risk.root_login.label", "shell.risk.root_login.explanation"));
  }
  return {
    program: "ssh",
    summary: t("shell.ssh.summary", { host: target }),
    details: [
      { label: t("shell.detail.action"), value: t("shell.action.ssh") },
      { label: t("shell.detail.host"), value: target },
    ],
    risks,
  };
};

const chmod: Handler = (tokens) => {
  const after = tokens.slice(1);
  const positional = nonFlagTokens(after);
  const mode = positional[0] ?? "(no mode)";
  const target = positional.slice(1).join(" ") || "(no target)";
  return {
    program: "chmod",
    summary: t("shell.chmod.summary", { mode, target }),
    details: [
      { label: t("shell.detail.action"), value: t("shell.action.chmod") },
      { label: t("shell.detail.mode"), value: mode },
      { label: t("shell.detail.target"), value: target },
    ],
    risks: [],
  };
};

const mv: Handler = (tokens) => {
  const after = tokens.slice(1);
  const positional = nonFlagTokens(after);
  const [source, destination] = [positional[0] ?? "(no source)", positional[1] ?? "(no destination)"];
  return {
    program: "mv",
    summary: t("shell.mv.summary", { source, destination }),
    details: [
      { label: t("shell.detail.action"), value: t("shell.action.mv") },
      { label: t("shell.detail.source"), value: source },
      { label: t("shell.detail.destination"), value: destination },
    ],
    risks: [],
  };
};

const generic: Handler = (tokens) => {
  const program = tokens[0] ?? "";
  const args = tokens.slice(1);
  return {
    program,
    summary: t("shell.summary.generic", { program, count: args.length }),
    details: [
      { label: t("shell.detail.action"), value: program },
      ...(args.length > 0 ? [{ label: t("shell.detail.flags"), value: args.join(" ") }] : []),
    ],
    risks: [],
  };
};

const HANDLERS: Readonly<Record<string, Handler>> = Object.freeze({
  git,
  rm,
  curl: curlOrWget,
  wget: curlOrWget,
  npm: packageManager,
  pnpm: packageManager,
  yarn: packageManager,
  ssh,
  chmod,
  mv,
});

export function handleCommand(tokens: readonly string[]): HandlerResult {
  if (tokens.length === 0) {
    return generic(tokens);
  }
  const program = tokens[0];
  if (program === undefined) {
    return generic(tokens);
  }
  const handler = HANDLERS[program] ?? generic;
  return handler(tokens);
}
