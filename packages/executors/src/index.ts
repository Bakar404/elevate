import type { ExecutorKind } from "@elevate/db";
import { CopilotCloudExecutor, MentionExecutor } from "./cloud";
import { FakeExecutor } from "./fake";
import { LocalExecutor } from "./local";
import type { Executor } from "./types";

export * from "./types";
export * from "./guard";
export * from "./fake";
export * from "./cloud";
export * from "./local";

export const EXECUTORS: { kind: ExecutorKind; label: string; description: string }[] = [
  { kind: "copilot-cloud", label: "Copilot coding agent", description: "Assigns an issue to GitHub Copilot, which opens a draft PR." },
  { kind: "claude-action", label: "Claude Code (Action)", description: "Mentions @claude on an issue; needs anthropics/claude-code-action in the repo." },
  { kind: "codex-cloud", label: "Codex cloud", description: "Mentions @codex on an issue; needs the Codex GitHub integration." },
  { kind: "local", label: "Local CLI agents", description: "Runs Copilot CLI, Claude Code or Codex in a fresh clone on this machine." },
  { kind: "fake", label: "Simulation", description: "Walks the plan without agents. For demos and tests." },
];

export function getExecutor(kind: ExecutorKind, opts: { codingAgentModel?: string; publishAsUser?: boolean } = {}): Executor {
  switch (kind) {
    case "copilot-cloud":
      return new CopilotCloudExecutor({ model: opts.codingAgentModel, publishAsUser: opts.publishAsUser });
    case "claude-action":
      return new MentionExecutor("claude-action", "Claude Code", "@claude");
    case "codex-cloud":
      return new MentionExecutor("codex-cloud", "Codex", "@codex");
    case "local":
      return new LocalExecutor();
    case "fake":
      return new FakeExecutor();
  }
}
