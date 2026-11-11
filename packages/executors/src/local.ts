import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveModel } from "@elevate/agent";
import { FakeGitHub } from "./fake";
import { guardedGitHub, type GuardedGitHub, type GuardOptions } from "./guard";
import { topoOrder, type Executor, type ExecutorOptions, type SwarmOutcome, type SwarmRun } from "./types";

export type LocalAgent = "copilot" | "claude" | "codex";

const benchmarkWriters = new WeakSet<GuardedGitHub>();

/** Fixture runs may only publish to this guarded in-memory writer. */
export function createLocalBenchmarkGitHub(options: GuardOptions) {
  const writer = new FakeGitHub();
  const github = guardedGitHub(writer, options);
  benchmarkWriters.add(github);
  return { github, writer };
}

/** Each CLI reads its task from a file, so prompts never pass through a shell. */
const AGENT_ARGS: Record<LocalAgent, (taskFile: string) => [string, string[]]> = {
  copilot: (f) => ["copilot", ["-p", `Follow the instructions in ${f}`, "--allow-all-tools", "--no-color"]],
  claude: (f) => ["claude", ["-p", `Follow the instructions in ${f}`, "--permission-mode", "acceptEdits"]],
  codex: (f) => ["codex", ["exec", "--full-auto", `Follow the instructions in ${f}`]],
};

function exec(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; timeoutMs?: number; fullOutput?: boolean; env?: Partial<NodeJS.ProcessEnv> } = {}) {
  // npm-installed CLIs are .cmd shims on Windows and need a shell; our args are fixed strings without quotes.
  const shell = process.platform === "win32" && cmd !== "git";
  return new Promise<{ code: number; out: string }>((resolve, reject) => {
    const child = spawn(cmd, shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args, {
      cwd: opts.cwd,
      signal: opts.signal,
      timeout: opts.timeoutMs,
      shell,
      env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, out: opts.fullOutput ? out : out.slice(-8000) }));
  });
}

async function git(cwd: string, args: string[], signal?: AbortSignal, fullOutput = false) {
  const r = await exec("git", args, { cwd, signal, fullOutput });
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

  constructor(
    private readonly agent: LocalAgent = (process.env.ELEVATE_LOCAL_AGENT as LocalAgent) || "copilot",
    private readonly options: ExecutorOptions = {},
  ) {
    this.label = `Local ${agent} CLI`;
  }

  async run(run: SwarmRun): Promise<SwarmOutcome> {
    const { github, repo, signal } = run;
    const model = this.options.model ?? resolveModel("swarm");
    const benchmark = this.options.benchmark;
    if (benchmark && !benchmarkWriters.has(github)) {
      throw new Error("Local benchmarks require createLocalBenchmarkGitHub; live GitHub writers are forbidden");
    }
    if (benchmark && (!Number.isSafeInteger(benchmark.verify.minimumTests ?? 1) || (benchmark.verify.minimumTests ?? 1) < 1)) {
      throw new Error("Local benchmark verification requires a positive minimumTests");
    }
    if (benchmark?.verify.successMarker !== undefined && !benchmark.verify.successMarker.trim()) {
      throw new Error("Local benchmark verification requires a nonempty successMarker");
    }
    const dir = await mkdtemp(join(tmpdir(), benchmark ? "elevate-benchmark-" : "elevate-swarm-"));
    try {
      const cwd = join(dir, "repo");
      let auth: string | undefined;
      if (benchmark) {
        await cp(benchmark.fixtureDirectory, cwd, { recursive: true, filter: (source) => basename(source) !== ".git" });
        await git(cwd, ["init"], signal);
        await git(cwd, ["add", "-A"], signal);
        await git(cwd, ["-c", "user.name=elevate", "-c", "user.email=elevate@users.noreply.github.com", "commit", "--allow-empty", "-m", "Benchmark fixture seed"], signal);
      } else {
        auth = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${await run.token()}`).toString("base64")}`;
        await git(dir, ["-c", `http.extraHeader=${auth}`, "clone", "--depth", "50", `https://github.com/${repo.fullName}.git`, "repo"], signal);
      }
      await git(cwd, ["checkout", "-b", run.branch], signal);
      await mkdir(join(cwd, ".elevate"), { recursive: true });
      await writeFile(join(cwd, ".git", "info", "exclude"), ".elevate/\n", { flag: "a" });

      for (const t of topoOrder(run.plan.tasks)) {
        if (t.role !== "implementer" && t.role !== "tester") {
          await run.setTask(t.key, "done");
          continue;
        }
        await benchmark?.onStage?.(t.role);
        await github.authorize("run_local_agent", repo.fullName, { task: t.key, agent: this.agent });
        await run.setTask(t.key, "running");
        const taskFile = join(".elevate", `${t.key}.md`);
        await writeFile(
          join(cwd, taskFile),
          [`# ${t.title}`, "", t.instructions, "", "## Context", run.recommendation.rationale, "", "## Verification", run.plan.verification, "", "Edit files only. Do not commit, push, or open pull requests."].join("\n"),
        );
        const [cmd, args] = AGENT_ARGS[this.agent](taskFile);
        if (model) args.push("--model", model);
        const r = await exec(cmd, args, { cwd, signal, timeoutMs: run.budgetMinutes * 60_000 });
        github.turn();
        if (r.code !== 0) {
          await run.setTask(t.key, "failed", r.out);
          throw new Error(`${this.agent} failed on ${t.key}`);
        }
        await run.setTask(t.key, "done", r.out.slice(-2000));
      }

      let verification: SwarmOutcome["verification"];
      if (benchmark) {
        await benchmark.onStage?.("tester");
        const { command, args, minimumTests = 1, successMarker } = benchmark.verify;
        const checked = await exec(command, args, {
          cwd,
          signal,
          timeoutMs: run.budgetMinutes * 60_000,
          env: { ELEVATE_BENCHMARK_WORKSPACE: cwd },
        }).catch((error: unknown) => {
          throw new Error(`Fixture verification failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        if (checked.code !== 0) throw new Error(`Fixture verification failed: ${checked.out}`);
        if (successMarker) {
          if (!checked.out.split(/\r?\n/).includes(successMarker)) {
            throw new Error("Fixture verification failed: trusted acceptance completion marker missing");
          }
        } else {
          const tests = Number(checked.out.match(/^# tests (\d+)\r?$/m)?.[1] ?? 0);
          const passed = Number(checked.out.match(/^# pass (\d+)\r?$/m)?.[1] ?? 0);
          if (tests < minimumTests || passed < minimumTests) {
            throw new Error(`Fixture verification failed: expected at least ${minimumTests} passing TAP tests, got ${passed}/${tests}`);
          }
        }
        verification = { command, args: [...args], output: checked.out };
      }
      await git(cwd, ["add", "-A"], signal);
      const status = await git(cwd, ["status", "--porcelain"], signal);
      if (!status.trim()) throw new Error("The agents made no changes");
      const diff = benchmark ? await git(cwd, ["diff", "--cached", "--binary"], signal, true) : undefined;
      if (benchmark?.beforePublish && verification && diff !== undefined) {
        await benchmark.onStage?.("reviewer");
        await benchmark.beforePublish(cwd, { diff, verification });
      }
      await git(cwd, ["-c", "user.name=elevate", "-c", "user.email=elevate@users.noreply.github.com", "commit", "-m", run.recommendation.title], signal);
      await github.authorizePush(repo.fullName, run.branch);
      if (!benchmark) {
        await git(cwd, ["-c", `http.extraHeader=${auth}`, "push", "origin", `HEAD:refs/heads/${run.branch}`], signal);
      }
      const pr = await github.openDraftPr(repo.fullName, {
        head: run.branch,
        base: repo.defaultBranch,
        title: run.recommendation.title,
        body: `${run.plan.summary}\n\n**Expected impact:** ${run.recommendation.expectedImpact}\n\n**Verification:** ${run.plan.verification}\n\n_Opened by elevate after both gates passed and you approved it._`,
      });
      await run.log(`Opened draft PR ${pr.url}`, "success");
      return {
        prUrl: pr.url,
        summary: `${this.label} finished ${run.plan.tasks.length} tasks`,
        ...(model ? { model } : {}),
        usage: null,
        ...(verification ? { verification } : {}),
        ...(diff !== undefined ? { diff } : {}),
      };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
