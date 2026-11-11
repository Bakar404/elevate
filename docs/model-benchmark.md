# Role-specific model benchmarks

Measure gates and implementation separately. Compare the **current configured/runtime model baseline against GPT-5.4 as the candidate**, not the other way around. The current model is measured without `--model`; GPT-5.4 is explicitly selected with `--model gpt-5.4`. This change does not change production defaults. Any default change belongs in a **separate PR**, with measured evidence and a rollback plan.

## Configuration and accounting

Model resolution is role override → `ELEVATE_MODEL` → existing configured/runtime default (no new default model selection):

| Variable | Role |
| --- | --- |
| `ELEVATE_MODEL_GATE1` | Legitimacy review |
| `ELEVATE_MODEL_GATE2` | Soundness review |
| `ELEVATE_MODEL_MATCHER` | Matching/profiling |
| `ELEVATE_MODEL_SWARM` | Planning and supported local coding-agent selection |

`--model` explicitly pins the benchmark model; gate evaluation also accepts `--model-gate1` and `--model-gate2`. Fake execution records the requested model only: it never invokes it. Cloud agents select their own implementation model; a requested planning model is not evidence of the cloud agent's model.

An empty/unset fallback omits the model flag rather than sending `auto` or an empty model ID. Swarm reports display `runtime default` and store a null model in that case.

For SDK-backed calls, `ELEVATE_PROVIDER` selects `copilot` (default), `openai`, `anthropic`, or `azure`. BYOK requires the provider's model ID, `ELEVATE_PROVIDER_BASE_URL`, and `ELEVATE_PROVIDER_API_KEY` from your environment/secret manager. Never put keys in reports or commit them. Copilot uses the configured account/subscription; BYOK routes through the configured provider. Local agent CLIs have their own authentication and availability requirements; SDK BYOK settings do not automatically configure them.

Usage snapshots group input/output tokens by role and model. Missing usage is **null**, not zero; opaque local/cloud agents cannot support token-cost comparisons. Supply current, verified prices with `ELEVATE_MODEL_PRICES_JSON`, mapping model IDs to numeric `inputPerMTok` and `outputPerMTok` rates in **USD per million tokens**. Schema template, not actual prices:

```text
{"MODEL_ID":{"inputPerMTok":INPUT_USD_PER_MILLION,"outputPerMTok":OUTPUT_USD_PER_MILLION}}
```

Estimated cost is `(inputTokens × inputRate + outputTokens × outputRate) / 1,000,000`. Unknown tokens, missing models, invalid JSON, or invalid rates produce null. No built-in prices or invented subscription charges are substituted. Estimates exclude caching discounts, tools, infrastructure, and subscription/premium-request billing.

## Exact commands

From the repository root, with workspace dependencies installed:

The swarm command prints a compact per-task table, total tokens/cost, and mean/sample-SD summary. `--out` saves the full machine-readable JSON report, including aggregate totals, verification evidence and partial SDK accounting.

```sh
# Offline gate reference checks; these do not measure model quality.
pnpm eval:gates --runs 3 --out reports/gates-reference.json

# Offline swarm plumbing check. SIMULATED: no agents or acceptance tests run.
pnpm bench:swarm --model gpt-5.4 --runs 3 --executor fake --out reports/swarm-fake-gpt-5.4.json

# Focused regression tests.
pnpm exec vitest run scripts/lib/eval-stats.test.ts scripts/lib/swarm-bench.test.ts
```

If a package-script alias is unavailable, the identical swarm entry point is:

```sh
pnpm exec tsx scripts/bench-swarm.ts --model gpt-5.4 --runs 3 --executor fake --out reports/swarm-fake-gpt-5.4.json
```

After obtaining authorized model access, run the current baseline and GPT-5.4 candidate:

```sh
pnpm eval:gates --live --runs 3 --out reports/gates-current.json
pnpm eval:gates --live --model gpt-5.4 --runs 3 --out reports/gates-gpt54.json

# Optional: isolate candidate Gate 1 while retaining current Gate 2.
pnpm eval:gates --live --model-gate1 gpt-5.4 --runs 3 --out reports/gates-role-split.json
```

Live gate evaluation calls models but does not publish to GitHub. No credentials were available for this implementation; **no live benchmark results are claimed**.

Keep the baseline's role/global model environment unchanged between repeats and preserve observed SDK model IDs. An unset model means runtime selection, not a secretly pinned model; record that limitation if the runtime changes its selection.

Live soundness prompts withhold fixture labels and reference verdicts to avoid answer leakage. The fixtures still supply sparse repository/technique context, not full source trees or implementation diffs: their scores measure decisions on that limited context, not production change soundness. Keep this limitation explicit when comparing models.

### Fixture-only local swarms

```sh
pnpm bench:swarm --runs 3 --executor local --out reports/swarm-current.json
pnpm bench:swarm --model gpt-5.4 --runs 3 --executor local --out reports/swarm-gpt54.json
```

Prerequisites: an installed/authenticated CLI selected by `ELEVATE_LOCAL_AGENT=copilot|claude|codex` (default Copilot), authorized SDK model access for planning/review, Node 22.12+, Python 3, and host `rustc`. Node acceptance processes explicitly use `--experimental-strip-types` so `.ts` fixture imports work at the minimum supported version. Missing CLI prerequisites produce a clear nonzero error rather than simulated success. SDK and CLI authentication/model availability are independent; ensure the explicitly selected model is supported by both. No credentials or coding CLIs were available for a live run during implementation.

The six runnable, intentionally defective seeds and immutable acceptance scripts are embedded in `fixtures/swarm-bench-tasks.json`. They are small stand-ins derived from the profiles in `packages/engine/src/demo.ts`, not full demo repository clones: TypeScript parser/posting, Python stub decoding/batching, and Rust host frame/scheduling functions. No external packages, model weights, hardware or inference service are needed by their acceptance tests.

For each task/repeat, the harness materializes a fresh seed in the system temporary directory. Actual `CopilotLLM` calls use role `swarm` and `PlanSchema` to plan from the source/specification. Actual `LocalExecutor` fixture mode copies that seed into a fresh local git repository with no remotes, skips remote clone/token acquisition and git push, runs the selected CLI, and independently executes acceptance checks. Trusted command arguments come from the committed fixture, not from the agent or model plan. Acceptance scripts are held in harness memory rather than trusted from writable model tests; a trusted wrapper requires the committed positive test count to complete successfully, so an early zero exit or omitted tests fails verification. A final `ReviewSchema` model call reviews the actual diff; rejection prevents draft capture.

The fixture path still calls `authorizePush` normally and captures a draft payload through `guardedGitHub` backed **only by FakeGitHub**. No executor path publishes an issue, branch or PR to GitHub. Materialized seeds and executor scratch use `mkdtemp` under the system temporary directory (`node:os.tmpdir()`, honoring `TMPDIR` where configured). Both are cleaned after each task; no scratch directories are created in the repository by default. This is the existing CLI trust/isolation model, **not an OS sandbox**: powerful agents are instructed to edit fixture files only and not perform network/git/GitHub operations. Run in a disposable container with suitable network/filesystem restrictions when stronger agent containment is required. Model planning/review and CLI inference necessarily use their configured model services.

Fake mode runs the **actual FakeExecutor task DAG** through **guardedGitHub** and an in-memory FakeGitHub writer, including authorization and budgets. It does not create real issues, PRs, git changes, model sessions, or network requests. Its only filesystem output is an explicitly requested JSON report; it never materializes or executes fixture code. A read-only `git rev-parse HEAD` records the report's revision.

## Reading swarm reports

- Each task records run index, requested model, simulated success/failure, `failureStage` (`plan`, `implement`, `test`, `review`; publishing failures count as review), elapsed milliseconds and `budgetExceeded`.
- Fake results always say `simulated: true`, `realSuccess: false`, `testsPassed: null`, and unknown tokens/cost as null. `simulatedTestsCompleted` only describes the fake DAG's tester step. A simulated success also requires a captured, guarded draft payload and all steps completed.
- A **real local** success must independently pass acceptance tests and produce a valid draft payload after model diff approval; agent exit code, prose claims, or an outcome URL alone are insufficient. Planning and review use the selected model; acceptance execution itself is deterministic and model-independent.
- Local reports expose `sdkUsage`, `sdkTokens` and `sdkCostUsd` for planning/review only. These are explicitly **partial**, not the whole swarm's usage: CLI accounting is unavailable, so per-task and aggregate total `tokens`/`costUsd` remain null. Unknown SDK usage/prices also remain null.
- Fixed per-task budget: four authorized agent tasks, five minutes, eight turns. Guard refusals and observed elapsed/turn overages fail the task. These are execution limits, not a financial budget.
- Report summaries calculate each run's task success fraction, then its mean and **sample standard deviation** across runs (`n - 1` denominator). One run reports SD zero by convention, not a confidence guarantee. Elapsed time, tokens and cost are aggregated per run; any unknown accounting keeps the corresponding aggregate null. Fake elapsed time measures harness overhead, not model latency.
- Reports include `fixtureSha256`, `gitSha` (null if unavailable), `generatedAt`, and provider/model configuration. Preserve those fields and the verified price date alongside results. Compare the same task set, repeats and budgets; never mix fake and live rows.

## Decision rule before changing defaults

Choose task/time/turn limits, a primary quality metric for the role being considered, and a maximum USD-per-run budget **before** running candidates. Run the current baseline and GPT-5.4 candidate on the same fixtures with at least three independent live repeats. Gate candidates must retain existing safety checks (no hype/unsound false positives, legitimate recall at least 0.75), not regress mean precision/recall, and not increase mean contradictions.

Recommend a change only when **all** conditions hold:

1. The candidate's mean improvement gap on the predeclared primary metric exceeds **one sample standard deviation**: `improvement > max(sd(candidate), sd(current))`. For precision, recall and success rate, improvement is `mean(candidate) - mean(current)`; for contradiction count it is `mean(current) - mean(candidate)`. A tie or smaller gap is inconclusive, not a win.
2. **Gate 2 precision does not regress** relative to the current baseline.
3. **Swarm test-and-draft success is not lower** than the current baseline, with no safety violations.
4. Both execution limits and the **configured/predeclared financial budget cap** are met using known complete cost. Null/unknown cost cannot establish affordability; partial SDK cost cannot establish a full-swarm saving.

Inspect per-task failures as well as means. If results are noisy, collect more repeats rather than declare a winner. Propose any role/default change in a **separate PR** with the saved reports; do not change defaults as part of the benchmark implementation. Without completed live runs, **no GPT-5.4 quality or savings recommendation is established**.

## Results TEMPLATE — not measured results

Fill only from saved live reports. `TBD` is intentionally not a measurement.

Record the fixture hash, git revision and repeat count alongside each comparison.

| Model | Gate | Precision mean ± SD | Recall mean ± SD | Contradictions mean ± SD | Input/output tokens (total) | USD (total) |
| --- | --- | --- | --- | --- | --- | --- |
| current baseline | 1 | TBD | TBD | TBD | TBD | TBD |
| gpt-5.4 candidate | 1 | TBD | TBD | TBD | TBD | TBD |
| current baseline | 2 | TBD | TBD | TBD | TBD | TBD |
| gpt-5.4 candidate | 2 | TBD | TBD | TBD | TBD | TBD |

| Model | Swarm success mean ± SD | Input/output tokens (total) | USD (total) | Budget overruns | Decision |
| --- | --- | --- | --- | --- | --- |
| current baseline | TBD | TBD | TBD | TBD | no decision |
| gpt-5.4 candidate | TBD | TBD | TBD | TBD | no decision |

Matcher/profiler selection needs its own labeled evaluation; these gate/swarm fixtures do not establish matching quality.
