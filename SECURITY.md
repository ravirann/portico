# Security Policy

Portico deals with browser automation, credentials, session state, screenshots, and workflow artifacts, and targets regulated domains (healthcare). Security issues are taken seriously.

## Reporting a vulnerability

Please do not open a public GitHub issue for vulnerabilities.

Use GitHub's private vulnerability reporting for this repository:

`Security → Advisories → Report a vulnerability`

Include:

- A clear description of the issue.
- Steps to reproduce.
- Affected versions or commit SHA, if known.
- Impact assessment.
- Any logs or screenshots with secrets removed.

## Supported versions

| Version | Supported |
| --- | --- |
| main | Best effort during early development |
| stable releases | To be defined |

## Secret handling expectations

Never commit:

- Passwords, tokens, API keys, cookies, or session storage.
- TOTP seeds/secrets or recovery codes.
- Captcha provider credentials.
- Screenshots or artifacts containing PHI or private user/tenant data.
- Production `.env` files.

Use secret *references* (resolved by `@portico/vault`); real values live in env or a
secret manager. Redaction is enforced by construction — never log, screenshot, or
persist secrets or PHI. Use `.env.example` for documentation only.

## Automation safety expectations

Automate only portals you (or your users) are authorized to access. Design flows
with clear boundaries, auditability, and explicit tenant isolation, and honor the
engine's guards (`no_booking`, `dry_run_only`, `forbidden_actions`) and the hard
egress boundary (`allowed_domains`). Avoid unsafe credential handling, uncontrolled
data exfiltration, and hidden side effects.
