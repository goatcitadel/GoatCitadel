export const repository = "https://github.com/goatcitadel/GoatCitadel";
export const productSite = "https://goatcitadel.app/";

export const groups = [
  {
    title: "Get started",
    pages: [
      {
        slug: "",
        title: "Overview",
        description: "Install GoatCitadel, connect a model, and run your AI workspace from Mission Control.",
      },
      {
        slug: "quickstart",
        title: "Quickstart",
        description: "From a fresh Windows install to your first reply in Chat.",
      },
      {
        slug: "install",
        title: "Install GoatCitadel",
        description: "Choose Windows, Docker, or a source install.",
        icon: "download",
      },
    ],
  },
  {
    title: "Using GoatCitadel",
    pages: [
      {
        slug: "mission-control",
        title: "Mission Control",
        description: "Find Chat, Inbox, Work, and Settings.",
        icon: "monitor",
      },
      {
        slug: "model-providers",
        title: "Model providers",
        description: "Connect a cloud model or a local endpoint.",
        icon: "layers",
      },
      {
        slug: "approvals",
        title: "Approvals",
        description: "Review the actions that need your decision.",
        icon: "shield",
      },
      {
        slug: "memory",
        title: "Memory",
        description: "Review what GoatCitadel remembers and where that context came from.",
      },
      {
        slug: "connectors-and-skills",
        title: "Connectors and skills",
        description: "Connect services, manage tools, and choose which skills the assistant can use.",
      },
    ],
  },
  {
    title: "Operate",
    pages: [
      {
        slug: "backup-and-recovery",
        title: "Backup and recovery",
        description: "Create and verify backups before updating or restoring a local runtime.",
      },
      {
        slug: "troubleshooting",
        title: "Troubleshooting",
        description: "Find out why the Gateway, a model, or a tool action is unavailable.",
      },
    ],
  },
  {
    title: "Reference",
    pages: [
      {
        slug: "architecture",
        title: "Architecture",
        description: "Understand the Gateway, Mission Control, and the records behind a run.",
      },
      {
        slug: "plugin-sdk",
        title: "Plugin SDK",
        description: "Write and validate a declarative plugin for GoatCitadel.",
      },
    ],
  },
];

export const pages = groups.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title })));
