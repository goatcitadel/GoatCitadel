import type { ShellRiskFinding } from "./shell-command-prescreen.js";

export interface ShellExplanationDetail {
  label: string;
  value?: string;
}

export interface HandledCommand {
  program: string;
  summary: string;
  details: readonly ShellExplanationDetail[];
  risks: readonly ShellRiskFinding[];
}

type Handler = (tokens: readonly string[]) => HandledCommand;

function handleGit(tokens: readonly string[]): HandledCommand {
  const program = "git";
  const sub = tokens[1] ?? "";
  const rest = tokens.slice(2);
  const details: ShellExplanationDetail[] = [];
  const risks: ShellRiskFinding[] = [];

  if (sub === "push") {
    const forceWithLease = rest.includes("--force-with-lease");
    const force = rest.includes("--force") || rest.includes("-f");
    const target = rest.filter((r) => !r.startsWith("-")).join(" ");
    if (forceWithLease) {
      details.push({ label: "Force", value: "with lease" });
      risks.push({ level: "danger", label: "Force-push with lease" });
      return {
        program,
        summary: `git push with lease — force-push to ${target}.`,
        details,
        risks,
      };
    }
    if (force) {
      details.push({ label: "Force", value: "true" });
      risks.push({ level: "danger", label: "Force-push" });
      return {
        program,
        summary: `git force-push to ${target}.`,
        details,
        risks,
      };
    }
    return {
      program,
      summary: `git push to ${target || "origin"}.`,
      details,
      risks,
    };
  }

  if (sub === "reset") {
    const hard = rest.includes("--hard");
    if (hard) {
      const ref = rest.filter((r) => !r.startsWith("-")).join(" ") || "HEAD";
      risks.push({ level: "danger", label: "Hard reset" });
      return {
        program,
        summary: `git hard reset — discards working tree changes for ${ref}.`,
        details,
        risks,
      };
    }
    return {
      program,
      summary: `git reset.`,
      details,
      risks,
    };
  }

  return {
    program,
    summary: `git ${[sub, ...rest].join(" ")}.`.trim(),
    details,
    risks,
  };
}

function handleRm(tokens: readonly string[]): HandledCommand {
  const program = "rm";
  const rest = tokens.slice(1);
  const details: ShellExplanationDetail[] = [];
  const risks: ShellRiskFinding[] = [];

  const flagTokens = rest.filter((r) => r.startsWith("-"));
  const positional = rest.filter((r) => !r.startsWith("-"));
  const flagString = flagTokens.join("");

  if (flagString.includes("r") || flagString.includes("R") || flagTokens.includes("--recursive")) {
    details.push({ label: "Recursive", value: "true" });
  }
  if (flagString.includes("f") || flagTokens.includes("--force")) {
    details.push({ label: "Force", value: "true" });
  }
  if (positional.length > 0) {
    details.push({ label: "Target", value: positional.join(" ") });
  }
  if (details.some((d) => d.label === "Recursive") && details.some((d) => d.label === "Force")) {
    risks.push({ level: "danger", label: "Recursive force delete" });
  }
  return {
    program,
    summary: `rm ${rest.join(" ")} — delete file(s).`,
    details,
    risks,
  };
}

function handleCurl(tokens: readonly string[]): HandledCommand {
  const program = "curl";
  const rest = tokens.slice(1);
  const details: ShellExplanationDetail[] = [];
  const risks: ShellRiskFinding[] = [];

  for (const tok of rest) {
    if (/^https?:\/\//i.test(tok)) {
      details.push({ label: "URL", value: tok });
    }
  }
  if (rest.includes("-k") || rest.includes("--insecure")) {
    risks.push({ level: "caution", label: "Insecure TLS" });
  }
  const url = details.find((d) => d.label === "URL")?.value ?? "URL";
  return {
    program,
    summary: `curl — fetch ${url}.`,
    details,
    risks,
  };
}

function handlePnpm(tokens: readonly string[]): HandledCommand {
  const program = "pnpm";
  const rest = tokens.slice(1);
  const details: ShellExplanationDetail[] = [];
  const risks: ShellRiskFinding[] = [];
  const sub = rest[0] ?? "";

  if (rest.includes("--global") || rest.includes("-g")) {
    risks.push({ level: "caution", label: "Global install" });
  }
  if (sub === "install") {
    return { program, summary: `pnpm install — install workspace dependencies.`, details, risks };
  }
  if (sub === "add") {
    return {
      program,
      summary: `pnpm add ${rest.slice(1).join(" ")}.`,
      details,
      risks,
    };
  }
  return { program, summary: `pnpm ${rest.join(" ")}.`, details, risks };
}

function handleSudo(tokens: readonly string[]): HandledCommand {
  const program = "sudo";
  const inner = tokens.slice(1);
  return {
    program,
    summary: `sudo — run as root: ${inner.join(" ")}.`,
    details: [],
    risks: [{ level: "caution", label: "Sudo" }],
  };
}

function handleChmod(tokens: readonly string[]): HandledCommand {
  const program = "chmod";
  const rest = tokens.slice(1);
  const risks: ShellRiskFinding[] = [];
  const details: ShellExplanationDetail[] = [];

  if (rest.includes("-R")) {
    details.push({ label: "Recursive", value: "true" });
  }
  for (const tok of rest) {
    if (/^7\d\d$/.test(tok) || tok.includes("o+w")) {
      risks.push({ level: "caution", label: "World-writable" });
      break;
    }
  }
  return {
    program,
    summary: `chmod ${rest.join(" ")} — change file permissions.`,
    details,
    risks,
  };
}

function handleEcho(tokens: readonly string[]): HandledCommand {
  const program = "echo";
  const rest = tokens.slice(1);
  return {
    program,
    summary: `echo ${rest.join(" ")}.`,
    details: [],
    risks: [],
  };
}

function handleGeneric(tokens: readonly string[]): HandledCommand {
  const program = tokens[0] ?? "";
  const args = tokens.slice(1);
  const argLabel = args.length === 1 ? "argument" : "arguments";
  return {
    program,
    summary: `Run ${program} with ${args.length} ${argLabel}.`,
    details: [],
    risks: [],
  };
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  git: handleGit,
  rm: handleRm,
  curl: handleCurl,
  pnpm: handlePnpm,
  sudo: handleSudo,
  chmod: handleChmod,
  echo: handleEcho,
};

export function handleCommand(tokens: readonly string[]): HandledCommand {
  const program = tokens[0] ?? "";
  const handler = HANDLERS[program] ?? handleGeneric;
  return handler(tokens);
}
