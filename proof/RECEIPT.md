# Receipt: elevate's policy kernel

**PASS.** Run 2026-11-10 20:37:41 UTC on win32 arm64, at elevate `uncommitted`. Written by `proof/run.mjs` from `proof/results/`; the requirements and decisions are in `proof/intent.md`.

## Requirements

| # | Requirement | Formally verified (Verus) | Mutant rejected | Empirically checked (D) |
|---|---|---|---|---|
| L1 | The legitimacy score is (2·prior + 3·review) / 5. | proved (L1) | ML1 | legitimacy: 0 of 816,080 differ |
| L2 | The score stays within 0 to 100. | proved (L2) | ML2 | legitimacy: 0 of 816,080 differ |
| L3 | More evidence never lowers the score or turns a pass into a fail. | proved (L3) | ML3 | legitimacy: 0 of 816,080 differ |
| L4 | The reviewer's "not legit" is a veto. | proved (L4) | ML4 | legitimacy: 0 of 816,080 differ |
| L5 | The model alone can't pass anything: evidence below the floor never passes. | proved (L5) | ML5 | legitimacy: 0 of 816,080 differ |
| L6 | Otherwise it passes exactly when the score reaches the threshold. | proved (L6) | ML6 | legitimacy: 0 of 816,080 differ |
| S1 | Nothing is sound for a technique that failed Gate 1. | proved (S1) | MS1 | soundness: 0 of 244,824 differ |
| S2 | The reviewer's "unsound" is a veto. | proved (S2) | MS2 | soundness: 0 of 244,824 differ |
| S3 | No way to measure the impact, no pass. | proved (S3) | MS3 | soundness: 0 of 244,824 differ |
| S4 | Riskier changes need a stronger case (+0, +5, +15). | proved (S4) | MS4 | soundness: 0 of 244,824 differ |
| S5 | Otherwise it passes exactly when the score reaches the risk-adjusted bar. | proved (S5) | MS5 | soundness: 0 of 244,824 differ |
| S6 | The inbox rank is exact, within 0 to 100, and monotone. | proved (S6) | MS6, MS6m | rank: 0 of 1,030,301 differ |
| T1 | Only an open recommendation is approved (or a failed one retried). | proved (T1) | MT1 | transition: 0 of 80 differ |
| T2 | A swarm starts only from approved; a PR or failure only from a running swarm. | proved (T2) | MT2 | transition: 0 of 80 differ |
| T3 | Nothing reaches the inbox without passing the gates. | proved (T3) | MT3 | transition: 0 of 80 differ |
| T4 | Gated out can only go back to candidate. | proved (T4) | MT4 | transition: 0 of 80 differ |
| T5 | A draft PR is the end. | proved (T5) | MT5 | transition: 0 of 80 differ |
| T6 | A rejected recommendation reopens as a candidate, re-gated. | proved (T6) | MT6 | transition: 0 of 80 differ |
| T7 | No swarm without both gates and your approval, for every event history. | proved (T7) | MT7 | replay: 0 of 131,111 differ |
| W1 | Never merge, push to the default branch, or force-push. | proved (W1) | MW1 | authorize: 0 of 72,000 differ |
| W2 | No write until you approve. | proved (W2) | MW2 | authorize: 0 of 72,000 differ |
| W3 | Only repos you opted in. | proved (W3) | MW3 | authorize: 0 of 72,000 differ |
| W4 | Only the recommendation's own repo. | proved (W4) | MW4 | authorize: 0 of 72,000 differ |
| W5 | Pull requests are drafts. | proved (W5) | MW5 | authorize: 0 of 72,000 differ |
| W6 | Agent work stops at the budget; publishing finished work doesn't. | proved (W6) | MW6 | authorize: 0 of 72,000 differ |
| W7 | Otherwise the write is allowed, and only then. | proved (W7) | MW7 | authorize: 0 of 72,000 differ |

## Steps

| Step | Command | Exit | Time | Result |
|---|---|---|---|---|
| Prove | `verus proof/verified/src/lib.rs --crate-type=lib --edition=2021` | 0 | 4.1 s | ok: 12 verified, 0 errors |
| Mutation check | `node proof/mutation-check.mjs` | 0 | 53.8 s | ok: 27 of 27 mutants rejected on their clause; draft gap shown |
| Build to WASM | `cargo build --release --target wasm32-unknown-unknown` | 0 | 3.2 s | ok: proof/build/elevate_policy.wasm, 22413 bytes |
| Test D | `vitest run packages/policy/test/differential.test.ts` | 0 | 4.4 s | ok: 0 of 2,294,396 inputs differ |
| Negative control | `MW2 to WASM; vitest run differential.test.ts` | 1 | 31.1 s | ok: D failed, as it must: 6,000 of 72,000 authorize inputs differ |

## Mutation check

One bug planted per clause in a scratch copy. Each must fail the proof on the clause it targets; one that proves means that clause rules out nothing.

| Mutant | Planted bug | Aimed at | Verus rejected it on | Result |
|---|---|---|---|---|
| ML1 | the prior outweighs the reviewer | L1 | L1, L6 | caught |
| ML2 | the score can exceed 100 (spec and code agree) | L2 | L2 | caught |
| ML3 | more evidence lowers the score (spec and code agree) | L3 | L3 | caught |
| ML4 | the reviewer's veto is ignored | L4 | L4, L6 | caught |
| ML5 | the model alone can pass a technique | L5 | L5, L6 | caught |
| ML6 | a score exactly at the threshold fails | L6 | L6 | caught |
| MS1 | Gate 2 ignores Gate 1 | S1 | S1, S5 | caught |
| MS2 | the reviewer's 'unsound' is ignored | S2 | S2, S5 | caught |
| MS3 | an unmeasurable change can pass | S3 | S3, S5 | caught |
| MS4 | high risk gets no margin (spec and code agree) | S4 | S4 | caught |
| MS5 | a score exactly at the bar fails | S5 | S5 | caught |
| MS6 | the rank under-weights soundness | S6 | S6 | caught |
| MS6m | a sounder change ranks lower (spec and code agree) | S6 | S6 | caught |
| MT1 | a candidate can be approved before the gates | T1 | T1 | caught |
| MT2 | a swarm starts from open, without approval | T2 | T2 | caught |
| MT3 | a rejected recommendation reopens straight into the inbox | T3 | T3, T6 | caught |
| MT4 | a gated-out recommendation can be rejected and reopened around the gates | T4 | T4 | caught |
| MT5 | an opened PR can be rejected and reopened | T5 | T5 | caught |
| MT6 | a rejected recommendation can't be reopened | T6 | T6 | caught |
| MT7 | replay starts past the gates | T7 | T7 | caught |
| MW1 | force-push is not forbidden | W1 | W1, W7 | caught |
| MW2 | an open (unapproved) recommendation may write | W2 | W2, W7 | caught |
| MW3 | the allow-list is skipped | W3 | W3, W7 | caught |
| MW4 | a swarm may write to another repo | W4 | W4, W7 | caught |
| MW5 | a ready-for-review PR may be opened | W5 | W5, W7 | caught |
| MW6 | the agent-turn budget is not enforced | W6 | W6, W7 | caught |
| MW7 | draft work is refused everywhere (over-strict) | W7 | W7 | caught |

**The draft-spec gap.** W1 to W6 only say when a write is refused. With them alone, today's guard proves and so does MW7, a guard that refuses every draft PR, so the safety clauses permit a guard that never lets a swarm deliver. W7 pins the exact rule.

## The differential test (D)

The shipped TypeScript (`packages/policy`) against the proved WASM:

| Section | Inputs | Mismatches | Outcomes seen |
|---|---|---|---|
| legitimacy | 816,080 | 0 | 202 |
| soundness | 244,824 | 0 | 2 |
| rank | 1,030,301 | 0 | 101 |
| transition | 80 | 0 | 9 |
| replay | 131,111 | 0 | 9 |
| authorize | 72,000 | 0 | 7 |

**Negative control.** The same test against mutant MW2 (an open (unapproved) recommendation may write) built to WASM must fail. It failed, as it must: 6,000 of 72,000 authorize inputs differ. One of them: `{"input":{"action":"create_issue","status":"open","allow":0,"same":0,"draft":0,"budget":[0,0,0,0,0,0]},"ts":2,"wasm":3}`.

## Trusted pieces

| | Trusted | Check |
|---|---|---|
| TB1 | The WASM shim's code mapping | D, and the negative control |
| TB2 | The TypeScript is what runs (decision D1) | D over every input class |
| TB3 | Every GitHub write goes through the guard | `guardedGitHub` unit test in packages/executors |
| TB4 | Normalization (`pct`) | packages/policy/test/policy.test.ts |
| TB5 | Verus 0.2026.11.02.8bf68ee, Z3, vstd, rustc 1.99.1 (58cf8f9c3 2026-10-13) | None: assumed, as in PDD Kit |
| TB6 | The intent, turned into clauses | Review of `proof/intent.md` |

## Versions and hashes

| | |
|---|---|
| Verus | 0.2026.11.02.8bf68ee |
| Rust | rustc 1.99.1 (58cf8f9c3 2026-10-13) |
| Node | v26.13.0 |
| Vitest | 5.1.0 |
| sha256 `proof/verified/src/lib.rs` | `2c656a5d50b85683945c51139fee333b876ca3924507610a5b2bca3bd637311d` |
| sha256 `packages/policy/src/index.ts` | `9e117ac3dbb352edf8d2e8a0de4395e34576862a378a2a4b351178a3fe879b2b` |
| sha256 `proof/build/elevate_policy.wasm` | `65118fc3ab754f27c9c1956cf7f1b81fc930d87dcdffa6b4a8ded9fb4923f6e4` |
| sha256 MW2 WASM (negative control) | `601b46b705f939db589c41a7bd86da99fca83bbf0b8c8958809ffe872d985b9a` |
