import { EventEmitter } from "node:events";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteRefused } from "@elevate/policy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CopilotCloudExecutor,
  createLocalBenchmarkGitHub,
  FakeExecutor,
  FakeGitHub,
  getExecutor,
  guardedGitHub,
  LocalExecutor,
  MentionExecutor,
  type GuardState,
  type LocalAgent,
  type SwarmRun,
} from "../src";

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn<() => string | undefined>(),
  snapshot: vi.fn(() => [{ role: "swarm", model: "unrelated-run", inputTokens: 999, outputTokens: 999 }]),
  commands: [] as { cmd: string; args: string[] }[],
  verificationExitCode: 0,
  verificationOutput: "Independent fixture tests\n# tests 2\n# pass 2\n",
}));

vi.mock("@elevate/agent", () => ({
  resolveModel: mocks.resolveModel,
  defaultUsageRecorder: { snapshot: mocks.snapshot },
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  mkdtemp: vi.fn(async () => ".executor-test"),
  cp: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  rm: vi.fn(async () => {}),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn((cmd: string, args: string[]) => {
    mocks.commands.push({ cmd, args: [...args] });
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    queueMicrotask(() => {
      if (cmd === "git" && args[0] === "status") child.stdout.emit("data", " M changed.ts\n");
      if (cmd === "git" && args[0] === "diff") child.stdout.emit("data", "diff --git a/changed.ts b/changed.ts\n");
      if (cmd === "node") child.stdout.emit("data", mocks.verificationOutput);
      child.emit("close", cmd === "node" ? mocks.verificationExitCode : 0);
    });
    return child;
  }),
}));

function setup(state: GuardState = { status: "in_progress", allowSwarm: true }, maxTasks = 5) {
  const fake = new FakeGitHub();
  const audits: unknown[] = [];
  const github = guardedGitHub(fake, {
    repoFullName: "Bakar404/demo",
    defaultBranch: "main",
    budget: { maxTasks, maxMinutes: 60, maxAgentTurns: 20 },
    state: async () => state,
    audit: async (_action, _target, details) => void audits.push(details.verdict),
  });
  const run: SwarmRun = {
    swarmId: "model-test",
    repo: { fullName: "Bakar404/demo", defaultBranch: "main" },
    recommendation: { id: "r1", title: "Test", rationale: "r", expectedImpact: "i" },
    plan: {
      summary: "Test",
      acceptanceCriteria: ["Tests pass"],
      verification: "pnpm test",
      tasks: [
        { key: "impl", role: "implementer", title: "Implement", instructions: "Edit", dependsOn: [] },
        { key: "test", role: "tester", title: "Test", instructions: "Test", dependsOn: ["impl"] },
      ],
    },
    branch: "elevate/model-test",
    github,
    token: async () => "test-token",
    log: async () => {},
    setTask: async () => {},
    budgetMinutes: 1,
    pollMs: 1,
  };
  return { fake, audits, run };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commands.length = 0;
  mocks.verificationExitCode = 0;
  mocks.verificationOutput = "Independent fixture tests\n# tests 2\n# pass 2\n";
  mocks.resolveModel.mockReturnValue("swarm-model");
});

afterEach(() => vi.unstubAllEnvs());

describe("swarm model selection", () => {
  for (const agent of ["copilot", "claude", "codex"] as LocalAgent[]) {
    it(`passes the swarm role's model to ${agent} for each agent task`, async () => {
      const { run } = setup();
      const result = await new LocalExecutor(agent).run(run);
      expect(mocks.resolveModel).toHaveBeenCalledExactlyOnceWith("swarm");
      const commands = mocks.commands.filter((c) => c.cmd === agent);
      expect(commands).toHaveLength(2);
      for (const { args } of commands) expect(args).toContain("--model");
      for (const { args } of commands) expect(args[args.indexOf("--model") + 1]).toBe("swarm-model");
      expect(result).toMatchObject({ model: "swarm-model", usage: null });
      expect(result.prUrl).toContain("/pull/");
    });

    it(`preserves an explicit ${agent} override unchanged`, async () => {
      const { run } = setup();
      const model = "vendor/custom-model:exact";
      const result = await new LocalExecutor(agent, { model }).run(run);
      expect(mocks.resolveModel).not.toHaveBeenCalled();
      const commands = mocks.commands.filter((c) => c.cmd === agent);
      expect(commands).toHaveLength(2);
      for (const { args } of commands) expect(args[args.indexOf("--model") + 1]).toBe(model);
      expect(result.model).toBe(model);
    });
  }

  it("forwards executor factory options to the local CLI", async () => {
    vi.stubEnv("ELEVATE_LOCAL_AGENT", "copilot");
    const { run } = setup();
    const result = await getExecutor("local", { model: "explicit" }).run(run);
    expect(result.model).toBe("explicit");
    expect(mocks.commands.find((c) => c.cmd === "copilot")?.args).toContain("explicit");
  });

  it.each(["", undefined])("leaves the CLI's default model untouched when resolution is %j", async (model) => {
    mocks.resolveModel.mockReturnValue(model);
    const { run } = setup();
    const result = await new LocalExecutor("copilot").run(run);
    expect(result).not.toHaveProperty("model");
    expect(mocks.commands.filter((c) => c.cmd === "copilot").every((c) => !c.args.includes("--model"))).toBe(true);
    expect(result.usage).toBeNull();
  });
});

describe("per-run usage", () => {
  it("does not copy global cumulative usage into CLI outcomes", async () => {
    const executor = new LocalExecutor("copilot");
    const first = await executor.run(setup().run);
    const second = await executor.run(setup().run);
    expect(first.usage).toBeNull();
    expect(second.usage).toBeNull();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("reports zero model usage for simulation, without selecting a model", async () => {
    const executor = getExecutor("fake", { model: "not-used" });
    const first = await executor.run(setup().run);
    const second = await executor.run(setup().run);
    expect(first.usage).toEqual([]);
    expect(second.usage).toEqual([]);
    expect(first.usage).not.toBe(second.usage);
    expect(first).not.toHaveProperty("model");
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("does not invent model or token counts for cloud delegation", async () => {
    const result = await new CopilotCloudExecutor().run(setup().run);
    expect(result.usage).toBeNull();
    expect(result).not.toHaveProperty("model");
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it("reports unknown usage for mention-based cloud agents", async () => {
    const { fake, run } = setup();
    const pr = { url: "https://github.com/Bakar404/demo/pull/42", number: 42, draft: true, state: "open" };
    vi.spyOn(fake, "linkedPrs").mockResolvedValue([pr]);
    const result = await new MentionExecutor("claude-action", "Claude", "@claude").run(run);
    expect(result.usage).toBeNull();
    expect(result).not.toHaveProperty("model");
  });
});

describe("model overrides do not bypass the guard", () => {
  const refusing: GuardState[] = [
    { status: "open", allowSwarm: true },
    { status: "candidate", allowSwarm: true },
    { status: "approved", allowSwarm: false },
    { status: "pr_opened", allowSwarm: true },
    { status: "rejected", allowSwarm: true },
  ];
  for (const state of refusing) {
    for (const executor of [
      new LocalExecutor("copilot", { model: "explicit" }),
      new FakeExecutor(),
      new CopilotCloudExecutor(),
      new MentionExecutor("claude-action", "Claude", "@claude"),
    ]) {
      it(`${executor.kind} refuses status=${state.status}, allowSwarm=${state.allowSwarm}`, async () => {
        const { run, fake, audits } = setup(state);
        await expect(executor.run(run)).rejects.toBeInstanceOf(WriteRefused);
        expect(fake.writes).toEqual([]);
        expect(audits.length).toBeGreaterThan(0);
        expect(audits.every((verdict) => verdict !== "allow")).toBe(true);
        expect(mocks.commands.filter((c) => c.cmd !== "git")).toEqual([]);
      });
    }
  }

  it("still stops local agent work when the task budget is exhausted", async () => {
    const { run, fake } = setup(undefined, 1);
    await expect(new LocalExecutor("copilot", { model: "explicit" }).run(run)).rejects.toMatchObject({
      verdict: "budget_exhausted",
    });
    expect(mocks.commands.filter((c) => c.cmd === "copilot")).toHaveLength(1);
    expect(fake.writes).toEqual([]);
  });
});

describe("fixture-only local benchmarks", () => {
  const benchmark = {
    fixtureDirectory: "fixtures/local",
    verify: { command: "node", args: ["--test"] },
  };

  function fixtureRun(state: GuardState = { status: "in_progress", allowSwarm: true }) {
    const { run } = setup(state);
    const audits: { action: string; verdict: unknown }[] = [];
    const { github, writer } = createLocalBenchmarkGitHub({
      repoFullName: run.repo.fullName,
      defaultBranch: run.repo.defaultBranch,
      budget: { maxTasks: 5, maxMinutes: 60, maxAgentTurns: 20 },
      state: async () => state,
      audit: async (action, _target, details) => void audits.push({ action, verdict: details.verdict }),
    });
    run.github = github;
    run.token = vi.fn(async () => { throw new Error("Benchmark must not request credentials"); });
    return { run, writer, audits };
  }

  it("copies fixtures without git metadata and verifies before guarded fake publication", async () => {
    const { run, writer, audits } = fixtureRun();
    const stages: string[] = [];
    const beforePublish = vi.fn(async (_cwd: string, _result: unknown) => {
      expect(writer.writes).toEqual([]);
      expect(rm).not.toHaveBeenCalled();
      expect(stages.at(-1)).toBe("reviewer");
    });
    const result = await new LocalExecutor("copilot", {
      model: "fixture-model",
      benchmark: { ...benchmark, beforePublish, onStage: (stage) => { stages.push(stage); } },
    }).run(run);
    expect(run.token).not.toHaveBeenCalled();
    expect(mkdtemp).toHaveBeenCalledWith(join(tmpdir(), "elevate-benchmark-"));
    expect(cp).toHaveBeenCalledWith(benchmark.fixtureDirectory, ".executor-test/repo", expect.objectContaining({ recursive: true }));
    const copyOptions = vi.mocked(cp).mock.calls[0]![2]!;
    expect(copyOptions.filter!("fixtures/local/.git", ".executor-test/repo/.git")).toBe(false);
    expect(copyOptions.filter!("fixtures/local/example.js", ".executor-test/repo/example.js")).toBe(true);
    const commands = mocks.commands;
    expect(commands.filter((c) => c.cmd === "git").some((c) => c.args.includes("init"))).toBe(true);
    expect(commands.some((c) => c.args.includes("clone") || c.args.includes("push") || c.args.includes("remote"))).toBe(false);
    expect(commands.filter((c) => c.cmd === "copilot")).toHaveLength(2);
    expect(commands.findIndex((c) => c.cmd === "node")).toBeGreaterThan(commands.findLastIndex((c) => c.cmd === "copilot"));
    expect(result.verification).toEqual({ command: "node", args: ["--test"], output: mocks.verificationOutput });
    expect(result).toMatchObject({ model: "fixture-model", usage: null });
    expect(result.diff).toBe("diff --git a/changed.ts b/changed.ts\n");
    expect(beforePublish).toHaveBeenCalledExactlyOnceWith(".executor-test/repo", {
      diff: result.diff,
      verification: result.verification,
    });
    expect(stages).toEqual(["implementer", "tester", "tester", "reviewer"]);
    expect(audits).toEqual(expect.arrayContaining([
      { action: "push_branch", verdict: "allow" },
      { action: "open_pr", verdict: "allow" },
    ]));
    expect(writer.writes.map((w) => w.op)).toEqual(["openDraftPr"]);
    expect(writer.writes[0]!.detail).toMatchObject({ head: run.branch, base: "main" });
    expect(rm).toHaveBeenCalledWith(".executor-test", { recursive: true, force: true });
  });

  it("rejects unregistered writers before filesystem or command activity", async () => {
    const { run, fake } = setup();
    await expect(new LocalExecutor("copilot", { benchmark }).run(run)).rejects.toThrow("live GitHub writers are forbidden");
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(mocks.commands).toEqual([]);
    expect(fake.writes).toEqual([]);
  });

  it("fails independently failing tests even when the CLI reports success", async () => {
    mocks.verificationExitCode = 1;
    const { run, writer, audits } = fixtureRun();
    await expect(new LocalExecutor("copilot", { benchmark }).run(run)).rejects.toThrow("Fixture verification failed");
    expect(writer.writes).toEqual([]);
    expect(audits.some((a) => a.action === "push_branch" || a.action === "open_pr")).toBe(false);
    expect(rm).toHaveBeenCalledWith(".executor-test", { recursive: true, force: true });
  });

  it("does not publish when independent model review rejects the fixture change", async () => {
    const { run, writer, audits } = fixtureRun();
    const beforePublish = vi.fn(async () => { throw new Error("Independent review rejected"); });
    await expect(new LocalExecutor("copilot", {
      benchmark: { ...benchmark, beforePublish },
    }).run(run)).rejects.toThrow("Independent review rejected");
    expect(beforePublish).toHaveBeenCalledOnce();
    expect(writer.writes).toEqual([]);
    expect(audits.some((a) => a.action === "push_branch" || a.action === "open_pr")).toBe(false);
    expect(rm).toHaveBeenCalledWith(".executor-test", { recursive: true, force: true });
  });

  it.each(["", "# tests 0\n# pass 0\n", "# tests 2\n# pass 0\n"])(
    "rejects missing or skipped acceptance tests even when verification exits successfully: %j",
    async (output) => {
      mocks.verificationOutput = output;
      const { run, writer } = fixtureRun();
      await expect(new LocalExecutor("copilot", { benchmark }).run(run)).rejects.toThrow("passing TAP tests");
      expect(writer.writes).toEqual([]);
    },
  );

  it("enforces the trusted fixture's minimum acceptance test count", async () => {
    const { run, writer } = fixtureRun();
    await expect(new LocalExecutor("copilot", {
      benchmark: { ...benchmark, verify: { ...benchmark.verify, minimumTests: 3 } },
    }).run(run)).rejects.toThrow("expected at least 3 passing TAP tests");
    expect(writer.writes).toEqual([]);
  });

  it("supports trusted multi-runtime assertion scripts with a completion marker", async () => {
    mocks.verificationOutput = "acceptance completed\nfixture-acceptance-ok\n";
    const { run, writer } = fixtureRun();
    const result = await new LocalExecutor("copilot", {
      benchmark: { ...benchmark, verify: { ...benchmark.verify, successMarker: "fixture-acceptance-ok" } },
    }).run(run);
    expect(result.verification?.output).toBe(mocks.verificationOutput);
    expect(writer.writes.map((w) => w.op)).toEqual(["openDraftPr"]);
  });

  it.each(["", "prefix-fixture-acceptance-ok-suffix\n"])(
    "rejects early-exiting assertions without their exact completion marker: %j",
    async (output) => {
      mocks.verificationOutput = output;
      const { run, writer } = fixtureRun();
      await expect(new LocalExecutor("copilot", {
        benchmark: { ...benchmark, verify: { ...benchmark.verify, successMarker: "fixture-acceptance-ok" } },
      }).run(run)).rejects.toThrow("completion marker missing");
      expect(writer.writes).toEqual([]);
    },
  );

  it("retains normal guard refusals before any CLI execution", async () => {
    const { run, writer, audits } = fixtureRun({ status: "approved", allowSwarm: false });
    await expect(new LocalExecutor("copilot", { benchmark }).run(run)).rejects.toBeInstanceOf(WriteRefused);
    expect(writer.writes).toEqual([]);
    expect(mocks.commands.filter((c) => c.cmd === "copilot" || c.cmd === "node")).toEqual([]);
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((a) => a.verdict !== "allow")).toBe(true);
  });
});
