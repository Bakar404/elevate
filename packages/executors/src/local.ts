import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { topoOrder, type Executor, type SwarmOutcome, type SwarmRun } from "./types";

export type LocalAgent = "copilot" | "claude" | "codex";

/** Each CLI reads its task from a file, so prompts never pass through a shell. */
const AGENT_ARGS: Record<LocalAgent, (taskFile: string) => [string, string[]]> = {
  copilot: (f) => ["copilot", ["-p", `Follow the instructions in ${f}`, "--allow-all-tools", "--no-color"]],
  claude: (f) => ["claude", ["-p", `Follow the instructions in ${f}`, "--permission-mode", "acceptEdits"]],
  codex: (f) => ["codex", ["exec", "--full-auto", `Follow the instructions in ${f}`]],
};

function exec(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
  // npm-installed CLIs are .cmd shims on Windows and need a shell; our args are fixed strings without quotes.
  const shell = process.platform === "win32" && cmd !== "git";
  return new Promise<{ code: number; out: string }>((resolve, reject) => {
    const child = spawn(cmd, shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
      cwd: opts.cwd,
      signal: opts.signal,
      timeout: opts.timeoutMs,
      shell,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.slice(-8000) }));
  });
}

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  const r = await exec("git", args, { cwd, signal });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.trim().slice(-500)}`);
  return r.out;
}

/**
 * Runs CLI coding agents (Copilot CLI, Claude Code, Codex) in a fresh clone, one task at a time in
 * dependency order, then pushes the swarm branch and opens a draft PR, all through the guard.
 * For isolation, run the worker inside a container (see docs/architecture.md).
 */
export class LocalExecutor implements Executor {
  readonly kind = "local" as const;
  readonly label: string;

  constructor(private readonly agent: LocalAgent = (process.env.ELEVATE_LOCAL_AGENT as LocalAgent) || "copilot") {
    this.label = `Local ${agent} CLI`;
  }

  async run(run: SwarmRun): Promise<SwarmOutcome> {
    const { github, repo, signal } = run;
    const dir = await mkdtemp(join(tmpdir(), "elevate-swarm-"));
    const auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${await run.token()}`).toString("base64")}`;
    try {
      await git(dir, ["-c", `http.extraHeader=${auth}`, "clone", "--depth", "50", `https://github.com/${repo.fullName}.git`, "repo"], signal);
      const cwd = join(dir, "repo");
      await git(cwd, ["checkout", "-b", run.branch], signal);
      await mkdir(join(cwd, ".elevate"), { recursive: true });
      await writeFile(join(cwd, ".git", "info", "exclude"), ".elevate/\n", { flag: "a" });

      for (const t of topoOrder(run.plan.tasks)) {
        if (t.role !== "implementer" && t.role !== "tester") {
          await run.setTask(t.key, "done");
          continue;
        }
        await github.authorize("run_local_agent", repo.fullName, { task: t.key, agent: this.agent });
        await run.setTask(t.key, "running");
        const taskFile = join(".elevate", `${t.key}.md`);
        await writeFile(
          join(cwd, taskFile),
          [`# ${t.title}`, "", t.instructions, "", "## Context", run.recommendation.rationale, "", "## Verification", run.plan.verification, "", "Edit files only. Do not commit, push, or open pull requests."].join("\n"),
        );
        const [cmd, args] = AGENT_ARGS[this.agent](taskFile);
        const r = await exec(cmd, args, { cwd, signal, timeoutMs: run.budgetMinutes * 60_000 });
        github.turn();
        if (r.code !== 0) {
          await run.setTask(t.key, "failed", r.out);
          throw new Error(`${this.agent} failed on ${t.key}`);
        }
        await run.setTask(t.key, "done", r.out.slice(-2000));
      }

      await git(cwd, ["add", "-A"], signal);
      const status = await git(cwd, ["status", "--porcelain"], signal);
      if (!status.trim()) throw new Error("The agents made no changes");
      await git(cwd, ["-c", "user.name=elevate", "-c", "user.email=elevate@users.noreply.github.com", "commit", "-m", run.recommendation.title], signal);
      await github.authorizePush(repo.fullName, run.branch);
      await git(cwd, ["-c", `http.extraHeader=${auth}`, "push", "origin", `HEAD:refs/heads/${run.branch}`], signal);
      const pr = await github.openDraftPr(repo.fullName, {
        head: run.branch,
        base: repo.defaultBranch,
        title: run.recommendation.title,
        body: `${run.plan.summary}\n\n**Expected impact:** ${run.recommendation.expectedImpact}\n\n**Verification:** ${run.plan.verification}\n\n_Opened by elevate after both gates passed and you approved it._`,
      });
      await run.log(`Opened draft PR ${pr.url}`, "success");
      return { prUrl: pr.url, summary: `${this.label} finished ${run.plan.tasks.length} tasks` };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
