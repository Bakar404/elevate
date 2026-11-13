# Architecture

A pnpm monorepo. The web app and the worker share one database and one engine.

```
apps/web         Next.js App Router UI and API routes (SSE for live events and chat)
apps/worker      standalone job runner (optional; the web app embeds one by default)
packages/engine  pipeline: profiler, ingest/triage, gates, matcher, swarm, chat tools, views
packages/agent   Copilot SDK runtime: structured LLM calls, chat sessions, BYOK, embeddings
packages/policy  the proved kernel in TypeScript (gates, lifecycle, write guard)
packages/executors  swarm executors and guardedGitHub, the only GitHub writer they get
packages/github  Octokit auth (token, stored token, or `gh auth token`), repo reads, writes
packages/sources HN (Algolia), RSS/Atom (AI lab blogs), arXiv connectors
packages/db      Drizzle schema, PGlite or Postgres, migrations, jobs, events, secrets
proof/           intent, Verus spec and proof, mutation check, receipt
```

## Data

Every table has a `tenant_id`, which is `local` for now.

- `repos`: GitHub metadata, the profile written by the model (stack, domains, key modules, test setup, improvement surfaces), and an embedding.
- `sources`, `items`, `techniques`: what came in, and the techniques extracted from it. Each technique carries its claims, its Gate 1 result and an embedding.
- `recommendations`: a technique × repo pair with a change hypothesis, both gate results, a score, and `status` plus an append-only `history` of lifecycle events.
- `swarms`, `swarm_tasks`: the task DAG, the executor, the budget, usage and the PR link.
- `jobs`: a Postgres-backed queue with dedupe keys, retries and backoff, claimed with `FOR UPDATE SKIP LOCKED`.
- `events`: the activity feed, streamed to the UI over SSE.
- `audit_log`: every guarded write and every settings change.
- `settings`, `secrets`: thresholds, budget, model config, and AES-256-GCM-encrypted tokens and keys.
- `threads`, `messages`: chat.

## Pipeline (jobs)

| Job | Does | Then |
|---|---|---|
| `repos.sync` | List your repos (every 2 minutes; `ELEVATE_SYNC_MINUTES`). For repos whose `pushed_at` moved, read the default-branch head SHA | `repo.profile` for watched repos whose head differs from the profiled commit |
| `repo.profile` | Read the README, manifests and tree at the head commit; model writes the profile; embed it; store `profiled_sha` | `repo.match` |
| `sources.sweep` | Every 15 minutes (`ELEVATE_SWEEP_MINUTES`), fan out to each enabled source | `source.fetch` |
| `sources.sweep` (cont.) | Feeds about a product the user doesn't have are skipped | |
| `source.fetch` | Fetch and dedupe items; drop ones published more than `ELEVATE_MAX_ITEM_AGE_DAYS` ago | `items.triage` |
| `items.triage` | Model keeps engineering-relevant items and extracts techniques, tagging each with the AI products it requires and the model versions it is about; near-duplicates (cosine ≥ 0.82) merge. A batch the content filter blocks is halved until only the items that trip it fail; a batch the model can't answer otherwise (prose instead of JSON, after one re-ask) fails whole. Failed items are marked `error` with the reason; each scheduled sweep retries them, up to `TRIAGE_TRIES` (3) failures, and **Sweep now** retries all of them | `technique.legitimacy`, unless the user can't act on it |
| `technique.legitimacy` | **Gate 1**: evidence prior (credibility, corroboration, HN signal, public code, cited links) plus a skeptical review, decided by `legitimacyDecision` | `technique.match` if passed |
| `technique.match` / `repo.match` | Top-K repos by embedding, then the model judges fit and writes a concrete change hypothesis | `recommendation.soundness` |
| `recommendation.soundness` | **Gate 2**: reads the touchpoint files, gets a review of fit, risk, impact and measurement, decided by `soundnessDecision` | `open` (inbox) or `gated_out` |
| `swarm.run` | Plan the DAG, run it on the chosen executor through the guard, open a draft PR | `pr_opened` and `prs.track`, or `failed` |
| `prs.track` | Every 2 minutes (`ELEVATE_PR_MINUTES`), and right after a swarm opens its PR: read each swarm PR's state, checks and mergeability, store it on the swarm, and follow merges, closes and reopens made on GitHub. With auto-merge on, merge the PRs that are verified | `merged` or `closed` |

### Access: what the user can act on

`packages/sources/src/ecosystem.ts` is pure: it finds vendors and model versions in text (`findModels`, `detectEcosystems`), and `judgeAccess` decides whether a technique is usable given what the user has. `packages/engine/src/access.ts` builds that profile:

- **Ecosystems** come from the provider (`detectAccess`), the vendors of the enabled models on a Copilot plan, an explicitly chosen executor, and the user's own switches (`access.overrides` in settings).
- **Available models** are the plan's live list, when the provider can list them.
- **Known models** are that list plus every version named in stored techniques and recent item titles. A version is superseded when a newer one on the same line is known and the plan doesn't still offer it. Nothing is hardcoded, so this can't go stale with the code.

The verdict is computed when it is used, not stored, so it follows the user's settings:

- triage holds unusable techniques back from Gate 1;
- `matchTechnique` returns without calling the model;
- the read models (`radar`, `discoveryFeed`, `listRecommendations`, `stats`) carry the verdict, so the UI can set things aside and say why;
- `recheckAccess` runs after a settings change and queues whatever is now usable.

This sits in front of the gates and never lets anything through them, so the proved kernel is unchanged.

Status changes go through `applyEvent`. It calls the proved `transition` function and appends to `history`, so every status can be replayed from its history; the tests check this.

Both gates ask the model through `consistentReview`. A review whose verdict and score disagree (for example `legit: true` with score 0, which the live eval caught) is asked again once. If the second answer also disagrees, the score is capped below 50, so a glitch can hide a recommendation but never let one through.

## Swarms

When you approve, you choose an executor. Approval adds `approve` to the history; it is refused unless the repo is opted in.

1. A planner call turns the recommendation into acceptance criteria and subtasks with dependencies. Two tasks are always added: `plan` first, and `review` last.
2. The executor runs the tasks:
   - **Cloud**:
     - `copilot-cloud` opens an issue and assigns it to Copilot's coding agent, using the model picked under Settings → "Swarms: Copilot coding agent" (`ELEVATE_CODING_AGENT_MODEL`; empty lets GitHub choose). The agent opens a `[WIP]` draft PR within seconds, so elevate keeps the swarm running until the PR timeline shows `copilot_work_finished` (or a failure), within the swarm's time budget.
     - `claude-action` opens an issue that mentions `@claude`, for the Claude Code Action.
     - `codex-cloud` opens an issue that mentions `@codex`.
     - Each agent opens the PR itself; elevate polls for it. The swarm's result records the planner model and the coding-agent model.
     - **Publish as me** (Settings → "Publish swarm PRs as me", default on; `ELEVATE_PUBLISH_AS_ME=0` turns the default off). When the coding agent finishes, elevate squashes its PR into one commit authored by you on the swarm's `elevate/<id>` branch, opens the draft PR from that branch under your account, and closes the agent's PR with a link to the new one. Closing a PR is the `close_pr` write, proved as decision D6: it is only allowed on an opted-in repo, for an approved recommendation, while its swarm is running.
     - **Resume**. Cloud swarms outlive the worker process. When a worker starts, `resumeSwarms` re-queues every swarm still marked `running` and re-attaches to its issue and PR instead of planning again, so a restart never marks a half-finished swarm as done.
   - **Local** creates a git worktree on a `elevate/<id>` branch and runs `copilot`, `claude` or `codex` non-interactively, one task at a time in dependency order. It then commits, pushes and opens a draft PR.
   - **Fake** is used in the demo and tests. It walks the same DAG and writes through the same guard to a fake GitHub.
3. Every write goes through `guardedGitHub`, which asks the proved `authorizeWrite` first and records the result in the audit log. Refusals throw `WriteRefused`.

## Pull requests

A swarm's job ends when its draft PR opens; `prs.track` (`packages/engine/src/prs.ts`) takes over from there. Each recommendation's latest succeeded swarm owns its PR, and older swarms' PRs are left alone.

- **Following.** Each check reads the PR fresh: state, draft, head SHA, mergeability, and every check run and commit status on the head commit (`pullRequestStatus` in `packages/github`). The result is kept in `swarms.result.pr`. Merges, closes and reopens made on GitHub move the recommendation to `merged`, `closed` or back to `pr_opened` (T5, D8). PRs closed in the last week are still followed, in case they are reopened.
- **Verified** (`prVerified`, M3) means at least one check passed, none failed, was cancelled or is still running, and GitHub reports the PR mergeable. A PR with no checks is never verified, so elevate never merges it.
- **Merging** needs your consent (M2): a click on Merge (`POST /api/swarms/:id/pr`), or "Auto-merge verified PRs" in Settings (`swarm.autoMerge`; `ELEVATE_AUTO_MERGE=1` changes the default). The guard re-reads the PR, asks `authorizeWrite` for `merge_pr` with those counts, marks a draft ready for review, squash-merges pinned to the head SHA it checked, and deletes the swarm branch if it lives in the same repo and isn't the default branch. If GitHub refuses (say, a branch rule), the refusal is stored for that head commit and auto-merge doesn't retry it until the branch moves.
- **Next step.** `prNextStep` turns what was seen into one stage with a title, the reason, and the actions that make sense: checking, waiting for workflow-run approval, checks failing, checks running, no checks, conflicts or behind, blocked by a branch rule, merge refused, auto-merging, ready to merge, merged, closed, swarms off for the repo, or superseded by a newer swarm. The swarm page, the recommendation page, the swarm and inbox lists and Home all show it.
- **Closing** (Close on the swarm page) also needs your consent and keeps the branch. Re-verify sends a closed recommendation back through Gate 2 (T6).

## Model runtime

`packages/agent` wraps the Copilot SDK:

- **Structured calls** (`CopilotLLM.json`) use a session with a zod schema. Strict providers reject JSON Schema bounds such as `minimum`/`maximum`, so `responseSchema()` (`schema.ts`) moves them into the field description, clamps small slips, and validates with zod. Tool parameters go through the same adapter.
- **Chat** uses a session with tools: list and explain recommendations, search the radar, read repos, propose a recommendation (which still has to pass both gates).
- **BYOK**: `ELEVATE_PROVIDER=anthropic|openai|azure` routes the session to your provider. You can also set it in Settings, where the key is stored encrypted.
- **Embeddings**: OpenAI if `OPENAI_API_KEY` is set, otherwise a local feature-hashing embedder. The local embedder is good enough for matching profiles to techniques, and it needs no network.

## Scaling out (SaaS path)

- Run the web app with `ELEVATE_EMBEDDED_WORKER=0` and N copies of `apps/worker`, all on one Postgres. The job claim uses `SKIP LOCKED`, so workers don't collide.
- The tenant scoping is already in the schema. Still to do: row-level security, a GitHub App instead of personal tokens, and per-tenant quotas.
