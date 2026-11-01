---
status: accepted
---

# Social authentication keeps credentials on the Mac

This extends ADR-0027's manual-login workflow: the Operator supplies X credentials through Admin and requests automatic re-login. The account's X handle remains separate from its private login ID.

## Decision

- Keep credentials only in agent-browser's encrypted auth vault on the Messages Mac. Admin and Cloudflare relay transient inputs over authenticated HTTPS and retain only account coordination state. Persona data, model input, public responses, social history and application logs never contain credentials or one-time codes.
- Pin authentication behavior to agent-browser 0.41.0, including its encrypted v1 profile format. Reject plaintext profiles and unsupported CLI versions. Use a private agent-browser HOME and short owner-only Unix socket directory, separate from personal CLI sessions.
- The CLI's `auth save` requires a username argument, and generic `auth login` requires both fields on one form. Write and read the same encrypted v1 profile using standard Node AES-256-GCM so neither ID nor password enters argv; publish keys exclusively and complete profiles atomically. A bounded host-side flow identifies X's stage metadata and sends private, origin-bound input through stdin batches. No model chooses secret selectors, reads credential fields, or sees the login screen.
- Serialize login, re-login and ordinary browser work per Social account. Keep authentication blockers across restarts. Automatic re-login occurs before continuing the original action; wrong credentials, CAPTCHA and verification codes require Operator attention, not an automatic retry loop.
- Preserve the account's enabled preference while login pauses its schedule. Current-generation callbacks resume only verified connections; persisted finite probes recover a lost callback. A disabled account stays disabled. Forgetting credentials explicitly stops activity.
- Release a write reservation only for a typed failure known to precede submit. Any interruption after submit remains uncertain and deduplicated.

## Alternatives

- Persisting credentials in Cloudflare would expand secret storage and require another encryption-key lifecycle despite the browser and vault already living on the Mac.
- Giving passwords to a Persona's browser prompt would put them into model history and tool traces.
- A blind generic `auth login`, or retrying the full social action after a login failure, cannot handle X's multi-step forms and external-write uncertainty correctly.

## Consequences

Credential and browser backups include the Mac's protected vault and encryption key. CLI upgrades require checking the vault/input contract. Manual challenges still need the visible Canary window. X history and browser cookies are not erased by forgetting saved credentials.
