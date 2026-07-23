# Security Policy

## Supported Versions

KARMA is an active buildathon submission under continuous development on `main`. Only the latest
commit on `main` is supported — there are no maintained release branches yet.

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities. Instead, report
privately through one of:

- [GitHub Security Advisories](https://github.com/Eilodon/KARMA-Eilodon/security/advisories/new)
  for this repository (preferred).
- Direct message on [Telegram](https://t.me/HoaTrungBinh) or [X/Twitter](https://x.com/MathEnemy).

Include a description of the issue, steps to reproduce, and (if applicable) the affected chain
(Casper Testnet / Stellar Testnet / Pharos Atlantic) and contract/package hash. We aim to
acknowledge reports within a few days.

## Scope & known limitations

This is testnet-deployed, pre-audit software — see the
[Security notes](README.md#security-notes) section of the README for the specific hardening
tradeoffs already documented (e.g. the external plugin runner's process-isolation scope, the
keystore's threat model). Findings that fall inside limitations already disclosed there are not
considered novel reports, but are still welcome as confirmation/hardening suggestions.
