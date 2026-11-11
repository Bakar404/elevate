# Security policy

elevate handles GitHub and model-provider tokens and can open pull requests, so security reports matter.

## Reporting a vulnerability

Do not open a public issue. Report it privately through [GitHub security advisories](https://github.com/Bakar404/elevate/security/advisories/new).

Please include the steps to reproduce, the affected version or commit, and the impact. You'll get an acknowledgement as soon as the report is read.

## Scope

In scope:
- Token or secret leakage.
- Any path where the agent writes to a repo without approval, or does something other than open a draft PR.
- Prompt injection from ingested sources that leads to unapproved actions.

## Supported versions

Only the latest commit on `main` is supported.
