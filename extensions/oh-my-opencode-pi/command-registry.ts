import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;
type RegisterCommand = (name: string, spec: {
  description: string;
  handler: CommandHandler;
  getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }>;
}) => void;

interface CommandRegistryHandlers {
  handleReviewCommand: CommandHandler;
  handlePantheonAgentsCommand: CommandHandler;
  handlePantheonCouncilCommand: CommandHandler;
  handlePantheonSpecStudioCommand: CommandHandler;
  handlePantheonBootstrapCommand: CommandHandler;
  handlePantheonAsCommand: CommandHandler;
  handlePantheonAttachCommand: CommandHandler;
  handlePantheonAttachAllCommand: CommandHandler;
  handlePantheonSubagentsCommand: CommandHandler;
  handlePantheonWatchCommand: CommandHandler;
  handlePantheonResultCommand: CommandHandler;
  handlePantheonTodosCommand: CommandHandler;
  handlePantheonOverviewCommand: CommandHandler;
  handlePantheonSidebarCommand: CommandHandler;
  handlePantheonResumeCommand: CommandHandler;
  handlePantheonRetryCommand: CommandHandler;
  handlePantheonBackgroundActionsCommand: CommandHandler;
  reviewModes: string[];
}

export function registerPantheonNamedCommands(registerCommand: RegisterCommand, handlers: CommandRegistryHandlers): void {
  registerCommand("review", {
    description: "Review uncommitted changes, committed ranges, commits, or pull requests with a defined review prompt",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trimStart();
      if (trimmed.includes(" ")) return [];
      return handlers.reviewModes
        .filter((mode) => mode.startsWith(trimmed))
        .map((mode) => ({ value: mode, label: mode }));
    },
    handler: handlers.handleReviewCommand,
  });

  registerCommand("pantheon-agents", {
    description: "Inspect Pantheon specialists and when to use them",
    handler: handlers.handlePantheonAgentsCommand,
  });

  registerCommand("pantheon-council", {
    description: "Interactively ask the council",
    handler: handlers.handlePantheonCouncilCommand,
  });

  registerCommand("pantheon-subagents", {
    description: "Inspect live or recent Pantheon subagent activity and jump to detailed logs/traces",
    handler: handlers.handlePantheonSubagentsCommand,
  });

  registerCommand("pantheon-spec-studio", {
    description: "Open an editor-first spec studio template",
    handler: handlers.handlePantheonSpecStudioCommand,
  });

  registerCommand("pantheon-bootstrap", {
    description: "Scaffold project-local Pantheon config and starter directories",
    handler: handlers.handlePantheonBootstrapCommand,
  });

  registerCommand("pantheon-as", {
    description: "Route the next task directly to a Pantheon specialist",
    getArgumentCompletions: (prefix) => {
      const names = ["explorer", "librarian", "oracle", "designer", "fixer", "council"];
      return names.filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
    },
    handler: handlers.handlePantheonAsCommand,
  });

  registerCommand("pantheon-attach", {
    description: "Open a tmux pane for a Pantheon background task log",
    handler: handlers.handlePantheonAttachCommand,
  });

  registerCommand("pantheon-attach-all", {
    description: "Open or reuse tmux panes for all queued/running background tasks",
    handler: handlers.handlePantheonAttachAllCommand,
  });

  registerCommand("pantheon-task-actions", {
    description: "Choose background task actions from an interactive Pantheon menu",
    handler: handlers.handlePantheonBackgroundActionsCommand,
  });

  registerCommand("pantheon-watch", {
    description: "Show live background task metadata and a recent log tail together",
    handler: handlers.handlePantheonWatchCommand,
  });

  registerCommand("pantheon-result", {
    description: "Show the final result for a background task",
    handler: handlers.handlePantheonResultCommand,
  });

  registerCommand("pantheon-todos", {
    description: "Show persisted Pantheon workflow todos",
    handler: handlers.handlePantheonTodosCommand,
  });

  registerCommand("pantheon-overview", {
    description: "Show combined Pantheon workflow and background overview",
    handler: handlers.handlePantheonOverviewCommand,
  });

  registerCommand("pantheon-sidebar", {
    description: "Open an experimental right-side Pantheon overlay sidebar",
    handler: handlers.handlePantheonSidebarCommand,
  });

  registerCommand("pantheon-resume", {
    description: "Show a resume brief from persisted workflow state and recent background tasks",
    handler: handlers.handlePantheonResumeCommand,
  });

  registerCommand("pantheon-retry", {
    description: "Retry a Pantheon background task with the same spec",
    handler: handlers.handlePantheonRetryCommand,
  });
}
