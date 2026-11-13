# Contributing to elevate

Thanks for helping. Issues, ideas and pull requests are all welcome.

## Good first contributions

- **A new source connector.** Add a feed (a blog, a newsletter, a subreddit, a conference's proceedings) in `packages/sources`. Each connector returns normalized items, and the rest of the pipeline handles dedupe, technique extraction and matching.
- **A new executor.** Add a way for the swarm to do work (another cloud agent or local CLI) in `packages/executors`.
- **Gate eval cases.** Add known-real and known-hype techniques to the eval set, then run `pnpm eval:gates` and include the precision and recall numbers in your PR.
- **UI polish.** Keep to the design notes in [docs/design.md](../docs/design.md), and check both light and dark themes.

## Setup

```sh
pnpm install
ELEVATE_DEMO=1 pnpm dev   # demo data, no tokens needed
```

See the [Quick start](../README.md#quick-start) for running with your GitHub and Copilot tokens.

## Before opening a PR

```sh
pnpm typecheck
pnpm test
pnpm test:e2e
```

- Write the test first. elevate is built proof-first: changes to gates, scoring or safety rails need a test that fails without the change.
- Keep PRs focused on one change.
- Never commit tokens, `.env` files or local data directories.

## Discussions

Questions and ideas go in [Discussions](https://github.com/Bakar404/elevate/discussions). Bugs and concrete feature requests go in [Issues](https://github.com/Bakar404/elevate/issues).

By contributing, you agree that your contributions are licensed under the [MIT License](../LICENSE).
