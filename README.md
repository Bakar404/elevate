# elevate

New techniques ship every week: proof-driven development, speculative decoding, weight-space editing, the next thing on Hacker News. elevate watches those sources for you. When something new would make one of **your** GitHub repos better, it raises a recommendation. It raises one only after checking two things:

1. **Is the new thing actually legit?** It looks at source credibility, independent corroboration, community signal, public code, and a skeptical model review.
2. **Is the change sound for this repo, and will it make a measurable difference?** It checks fit with the repo, risk, and a concrete way to measure the impact.

You approve, and elevate sends a swarm of agents that plan, implement, test and review the change, then open a **draft** PR. It never merges.

The model runtime is the [GitHub Copilot SDK](https://github.com/github/copilot-sdk), so it runs on your Copilot subscription. Bring your own key to use Anthropic, OpenAI or Azure models. Swarms can run on the Copilot coding agent, Claude (GitHub Action), Codex cloud, or local `copilot` / `claude` / `codex` CLIs in git worktrees.

## Quick start

```sh
pnpm install
cp .env.example .env            # optional; everything has a default
pnpm dev                        # http://localhost:3100
```

- **Real mode:** sign in to GitHub with `gh auth login`, or paste a token in Settings. The model runs through your Copilot login. Turn on **Watch** for your repos and **Swarms** for the ones elevate may write to.
- **Offline demo:** `ELEVATE_DEMO=1 pnpm dev`. This uses sample repos and sources, a deterministic model, and simulated swarms, with no GitHub access.
- **Check the model runtime:** `pnpm smoke:copilot` makes one structured call through Copilot, or through your BYOK provider.

## How it works

```
sources (HN, AI lab blogs, arXiv) ─► triage ─► techniques ─► Gate 1: legitimacy
                                                                  │ pass
your repos ─► profiles + embeddings ─► matcher ─► candidates ─► Gate 2: soundness
                                                                  │ pass
                                             inbox ◄──────────────┘
                                               │ you approve (and opt the repo in)
                                     swarm: plan → implement → test → review ─► draft PR
```

See [docs/architecture.md](docs/architecture.md) for the packages, jobs and data model, and [docs/design.md](docs/design.md) for the UI.

## Built proof-first

The rules that stand between a headline and a branch on your repo are **proved**, not just tested:

- Gate 1 and Gate 2 decisions
- the recommendation lifecycle ("no swarm without both gates and your approval")
- the write guard ("never merge, only opted-in repos, drafts only, within budget")

They follow the [PDD Kit](https://www.microsoft.com/en-us/research/blog/formally-verifying-agent-written-full-stack-web-apps-with-pdd-kit/) method:

1. **Intent:** [`proof/intent.md`](proof/intent.md) states 26 requirements in plain words.
2. **Spec and proof:** [`proof/verified/src/lib.rs`](proof/verified/src/lib.rs) states each requirement in Verus and proves it for every input.
3. **Mutation check:** one bug is planted per clause, and Verus must reject each one.
4. **Differential test:** the TypeScript the app runs (`packages/policy`) is compared with the proved code, built to WASM, over every input class. A **negative control** proves the test can fail.
5. **Receipt:** [`proof/RECEIPT.md`](proof/RECEIPT.md), also shown on the Settings page.

What the proof can't cover is the quality of the model's judgments. The gate eval set measures that: `pnpm eval:gates` runs the reference reviews, and `pnpm eval:gates --live` asks your model for the Gate 1 reviews. See [`fixtures/gate-eval.json`](fixtures/gate-eval.json).

Last live run (Copilot default model):

| Gate 1 | Result |
|---|---|
| Precision | 1.00 |
| Recall | 0.89 |
| Hype cases passed | 0 of 7 |

- The only miss was a deliberately borderline "fresh preprint".
- Gate 2 judged 7 of 7 cases correctly. It is scored on the reference reviews, because `--live` replaces only the Gate 1 reviews.
- 3 of 16 reviews contradicted themselves and were re-asked (see `consistentReview` in [docs/architecture.md](docs/architecture.md)).

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Web app with the embedded worker on :3100 |
| `pnpm worker` | Standalone worker (set `ELEVATE_EMBEDDED_WORKER=0` on the web app and use Postgres) |
| `pnpm test` | Unit and integration tests (vitest) |
| `pnpm test:e2e` | Playwright end-to-end run against the demo |
| `pnpm typecheck` | Type-check every package |
| `pnpm eval:gates [--live]` | Gate precision and recall on the eval set, plus a threshold sweep |
| `pnpm smoke:copilot` | One live call through the Copilot SDK or BYOK provider |
| `pnpm proof` | Re-run proof, mutation check, WASM build, differential test and negative control, then rewrite the receipt (needs Verus) |

## Storage

Local mode uses embedded PGlite (Postgres in WASM) with pgvector, stored in `.data/`. Set `DATABASE_URL` to use a real Postgres instead; `docker compose up db` starts one. Every table has a `tenant_id`, so the move to multi-tenant SaaS is planned for. Tokens and API keys are encrypted at rest (AES-GCM, key in `ELEVATE_SECRET` or `.data/secret.key`).

`docker compose up --build` runs Postgres, the web app and a separate worker from one image. Put `GITHUB_TOKEN` (and any BYOK key) in `.env`; inside a container there is no `gh` login to fall back on. If registry.npmjs.org is blocked on your network, point the image build at a mirror: `NPM_REGISTRY=https://your-mirror/npm/ docker compose build`.

## Safety rails

- Nothing is written to GitHub until you approve, and only to repos you opted in.
- Pull requests are drafts. elevate never merges, pushes to a default branch, or force-pushes.
- Every swarm has a budget for tasks, minutes and agent turns.
- Every write is checked by the proved guard and recorded in the audit log.
