# Contributing to KARMA

KARMA is currently a solo-builder buildathon submission (see
[Roadmap & team](README.md#roadmap--team)), but issues and pull requests are welcome — especially
around the public, chain-agnostic interfaces in [`docs/standards/`](docs/standards/), where a
second independent implementation is explicitly one of the project's next steps.

## Getting started

Follow the [Quick start](README.md#quick-start) section in the README for install, keystore
setup, and running the server locally. [DEMO_CASPER.md](DEMO_CASPER.md) and
[DEMO_STELLAR.md](DEMO_STELLAR.md) are the fastest way to see the full system working end-to-end
before making changes.

## Before opening a PR

- `pnpm typecheck` and `pnpm test` must pass (same checks as CI, see
  [`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- `pnpm audit --audit-level high` should be clean, or the new finding explained in the PR.
- For contract changes under `contracts-odra/`, run `cargo +nightly test --manifest-path
  contracts-odra/Cargo.toml`.
- Keep changes scoped — this repo favors small, reviewable diffs over broad refactors.

## Reporting bugs / requesting features

Use the issue templates. For security-sensitive reports, follow [SECURITY.md](SECURITY.md)
instead of filing a public issue.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
