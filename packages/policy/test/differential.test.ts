/**
 * D: the shipped TypeScript (packages/policy) against the proved Verus build
 * (proof/build/elevate_policy.wasm) on every input class. TB1 and TB2 in
 * proof/intent.md. `pnpm proof` runs this, then runs it again against a
 * mutant build, where it must fail (the negative control).
 *
 * ELEVATE_POLICY_WASM overrides the module; PDD_RESULTS writes a JSON summary.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACTIONS,
  EVENTS,
  STATUSES,
  VERDICTS,
  authorizeWrite,
  legitimacyDecision,
  recommendationScore,
  replay,
  soundnessDecision,
  transition,
  type LifecycleEvent,
  type Risk,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
// Results are committed: show repo-relative or %TEMP%-relative paths, never this machine's home directory.
const shownPath = (p: string) => {
  const rel = relative(resolve(here, "../../.."), p);
  if (!rel.startsWith("..")) return rel.replaceAll("\\", "/");
  const tmp = process.env.TEMP ?? tmpdir();
  return p.startsWith(tmp) ? `%TEMP%${p.slice(tmp.length)}` : p;
};
const wasmPath = process.env.ELEVATE_POLICY_WASM ?? resolve(here, "../../../proof/build/elevate_policy.wasm");

type Exports = {
  legitimacy_code(p: number, r: number, legit: number, t: number, f: number): number;
  soundness_code(g1: number, sound: number, meas: number, score: number, risk: number, t: number): number;
  score_code(a: number, b: number, c: number): number;
  transition_code(s: number, e: number): number;
  replay_code(packed: bigint): number;
  authorize_code(...args: number[]): number;
};

const RISKS: Risk[] = ["low", "medium", "high"];
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const B = [0, 1] as const;

type Section = { name: string; inputs: number; mismatches: number; example?: unknown; outcomes: Record<string, number> };
const sections: Section[] = [];

function section(name: string) {
  const s: Section = { name, inputs: 0, mismatches: 0, outcomes: {} };
  sections.push(s);
  return {
    s,
    check(ts: unknown, wasm: unknown, input: () => unknown) {
      s.inputs++;
      const key = String(ts);
      s.outcomes[key] = (s.outcomes[key] ?? 0) + 1;
      if (ts !== wasm) {
        s.mismatches++;
        s.example ??= { input: input(), ts, wasm };
      }
    },
  };
}

function pack(events: number[]): bigint {
  let p = BigInt(events.length) << 60n;
  events.forEach((e, i) => (p |= BigInt(e) << BigInt(4 * i)));
  return p;
}

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe.skipIf(!existsSync(wasmPath))("D: packages/policy against the proved build", async () => {
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath));
  const w = instance.exports as unknown as Exports;

  it("Gate 1: every prior and review, at every threshold and floor boundary", () => {
    const c = section("legitimacy");
    for (const t of [0, 1, 30, 59, 60, 61, 99, 100])
      for (const f of [0, 29, 30, 31, 100])
        for (const legit of B)
          for (let p = 0; p <= 100; p++)
            for (let r = 0; r <= 100; r++) {
              const d = legitimacyDecision({ prior: p, review: r, legit: legit === 1 }, { legitimacy: t, priorFloor: f });
              c.check(d.score * 2 + (d.passed ? 1 : 0), w.legitimacy_code(p, r, legit, t, f), () => ({ p, r, legit, t, f }));
            }
    expect(c.s.mismatches, JSON.stringify(c.s.example)).toBe(0);
  });

  it("Gate 2: every score and threshold, every flag and risk", () => {
    const c = section("soundness");
    for (const g1 of B)
      for (const sound of B)
        for (const meas of B)
          for (const [ri, risk] of RISKS.entries())
            for (let t = 0; t <= 100; t++)
              for (let score = 0; score <= 100; score++) {
                const d = soundnessDecision({ gate1Passed: g1 === 1, sound: sound === 1, measurable: meas === 1, score, risk }, t);
                c.check(d.passed ? 1 : 0, w.soundness_code(g1, sound, meas, score, ri, t), () => ({ g1, sound, meas, score, risk, t }));
              }
    expect(c.s.mismatches, JSON.stringify(c.s.example)).toBe(0);
  });

  it("Rank: every relevance, legitimacy and soundness", () => {
    const c = section("rank");
    for (let a = 0; a <= 100; a++)
      for (let b = 0; b <= 100; b++)
        for (let s = 0; s <= 100; s++) c.check(recommendationScore(a, b, s), w.score_code(a, b, s), () => ({ a, b, s }));
    expect(c.s.mismatches, JSON.stringify(c.s.example)).toBe(0);
  });

  it("Lifecycle: all 80 status and event pairs", () => {
    const c = section("transition");
    for (const [si, s] of STATUSES.entries())
      for (const [ei, e] of EVENTS.entries()) {
        const next = transition(s, e);
        c.check(next === null ? 0 : STATUSES.indexOf(next) + 1, w.transition_code(si, ei), () => ({ s, e }));
      }
    expect(c.s.mismatches, JSON.stringify(c.s.example)).toBe(0);
  });

  it("Replay: every history up to 5 events, and 20,000 random ones up to 15", () => {
    const c = section("replay");
    const run = (seq: number[]) => {
      const ts = replay(seq.map((i) => EVENTS[i] as LifecycleEvent));
      c.check(ts === null ? 0 : STATUSES.indexOf(ts) + 1, w.replay_code(pack(seq)), () => seq.map((i) => EVENTS[i]));
    };
    const all = (prefix: number[], depth: number) => {
      run(prefix);
      if (depth === 0) return;
      for (let e = 0; e < EVENTS.length; e++) all([...prefix, e], depth - 1);
    };
    all([], 5);
    // Random walks that mostly follow allowed transitions, so long histories
    // reach every status instead of failing at the first step.
    const rand = rng(7);
    for (let n = 0; n < 20_000; n++) {
      const len = 1 + Math.floor(rand() * 15);
      const seq: number[] = [];
      let s: (typeof STATUSES)[number] | null = "candidate";
      for (let i = 0; i < len; i++) {
        const cur: (typeof STATUSES)[number] | null = s;
        const allowed: number[] = cur ? EVENTS.map((e, ei) => (transition(cur, e) ? ei : -1)).filter((x) => x >= 0) : [];
        const pick: number = allowed.length && rand() < 0.9 ? allowed[Math.floor(rand() * allowed.length)]! : Math.floor(rand() * EVENTS.length);
        seq.push(pick);
        s = s ? transition(s, EVENTS[pick]!) : null;
      }
      run(seq);
    }
    expect(c.s.mismatches, JSON.stringify(c.s.example)).toBe(0);
  });

  it("Write guard: every action, status and flag, at the budget boundaries", () => {
    const c = section("authorize");
    const pairs: [number, number][] = [
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [4, 5],
    ];
    for (const [ai, action] of ACTIONS.entries())
      for (const [si, status] of STATUSES.entries())
        for (const allow of B)
          for (const same of B)
            for (const draft of B)
              for (const [tu, tm] of pairs)
                for (const [mu, mm] of pairs)
                  for (const [uu, um] of pairs) {
                    const v = authorizeWrite({
                      action,
                      status,
                      allowSwarm: allow === 1,
                      sameRepo: same === 1,
                      draft: draft === 1,
                      usage: { tasks: tu, minutes: mu, agentTurns: uu },
                      budget: { maxTasks: tm, maxMinutes: mm, maxAgentTurns: um },
                    });
                    c.check(VERDICTS.indexOf(v), w.authorize_code(ai, si, allow, same, draft, tu, tm, mu, mm, uu, um), () => ({
                      action,
                      status,
                      allow,
                      same,
                      draft,
                      budget: [tu, tm, mu, mm, uu, um],
                    }));
                  }
    expect(c.s.mismatches, JSON.stringify(c.s.example)).toBe(0);
  });

  it("coverage: every outcome occurs", () => {
    const by = Object.fromEntries(sections.map((s) => [s.name, s]));
    expect(Object.keys(by.authorize?.outcomes ?? {}).sort()).toEqual(VERDICTS.map((_, i) => String(i)).sort());
    expect(Object.keys(by.transition?.outcomes ?? {}).length).toBe(STATUSES.length + 1); // all 8 statuses + none
    expect(Object.keys(by.replay?.outcomes ?? {}).length).toBe(STATUSES.length + 1); // all 8 statuses + none
    if (process.env.PDD_RESULTS) {
      writeFileSync(process.env.PDD_RESULTS, `${JSON.stringify({ wasm: shownPath(wasmPath), sections }, null, "\t")}\n`);
    }
  });
});

it("D is not silently skipped in CI", () => {
  if (process.env.CI || process.env.PDD_REQUIRE_WASM) expect(existsSync(wasmPath), `missing ${join(wasmPath)}`).toBe(true);
});
