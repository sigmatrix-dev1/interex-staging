# Interex Technical Specification (Concise)

Last updated: 2025-10-06

This document summarizes the current implemented architecture & critical security controls. For broader product/system context see `INTEREX_SYSTEM_SPEC.md` and phased roadmap in `SECURITY_ENHANCEMENT_PHASES.md`.

## Stack Overview
Runtime: Node.js / Express hosting a React Router 7 SSR application (Remix lineage). Build pipeline via Vite (ESM), TypeScript throughout.
Data: Prisma ORM currently targeting SQLite (LiteFS in Fly). Planned Postgres migration TBD.
Styling: Tailwind CSS + component primitives.
Auth: Username/password + mandatory TOTP MFA (universal). Recovery codes (privileged issuance). Account lockout (flag gated). CSRF double-submit token for all mutating form POSTs.
Auditing: Append-only `AuditEvent` with hash chain, optimistic concurrency using unique (chainKey, seq). Security events (failure + anomaly groundwork).
Notifications: In-app persisted notification rows serialized on root loader.

## Content Security Policy
Implemented via per-request nonce in `app/entry.server.tsx` (SSR entry). Document responses receive a header like:

```
Content-Security-Policy: 
	default-src 'self';
	base-uri 'self';
	frame-ancestors 'none';
	form-action 'self';
	object-src 'none';
	connect-src 'self' ws: *.sentry.io; (ws: only in development, sentry only if DSN set)
	img-src 'self' data:;
	font-src 'self' data:;
	script-src 'strict-dynamic' 'self' 'nonce-<random16bytes>';
	script-src-attr 'nonce-<same>';
	style-src 'self';
```

Key Properties:
* strict-dynamic + nonce removes need to whitelist hashed bundles and blocks injection without nonce.
* No `unsafe-inline` for scripts or styles.
* Tailwind delivered as a static stylesheet (`style-src 'self'`). No inline style exceptions required presently.
* Frame embedding fully disabled (defense-in-depth vs clickjacking).
* connect-src narrowed (Sentry + dev websocket). Add future API origins explicitly.

Rollback: Remove strict-dynamic and fall back to `'self'` + nonce (still secure) if a third-party script loader scenario emerges that conflicts.

## Additional Security Headers
Set in `server/index.ts` (non HTML-specific logic):
* Strict-Transport-Security: 63072000; includeSubDomains; preload (prod + https only)
* X-Content-Type-Options: nosniff
* X-Frame-Options: DENY (redundant with CSP frame-ancestors)
* Permissions-Policy: geolocation=(), camera=(), microphone=()
* Cross-Origin-Opener-Policy: same-origin
* Cross-Origin-Resource-Policy: same-origin

Referrer-Policy intentionally deferred (previous logic depends on referrer for redirect decisions). Will revisit once dependency removed; expected target: `strict-origin-when-cross-origin`.

## CSRF Defense
Double submit token generation (`getOrCreateCsrfToken`) + `<CsrfInput />` injection. Early inline script (nonce governed) auto-patches missing forms for defense-in-depth. Runtime mode currently `log`, tests enforce; planned flip after observation window.

## MFA & Credentials
TOTP secrets encrypted at rest using AES-256-GCM; master key via `TOTP_ENC_KEY` / `MFA_ENCRYPTION_KEY`. Universal enforcement: any user without secret is forced through setup then verification; app routes blocked until satisfied. Recovery codes hashed (bcrypt) and single-use.

## Account Lockout
Incremental backoff based on failure counters; gated by `LOCKOUT_ENABLED`. Emits audit + security events (`AUTH_LOCKOUT_TRIGGERED`, `LOGIN_FAILURE`).

## Audit Integrity
`AuditEvent(chainKey, seq)` unique constraint; hash prevHash + canonical payload. Insert uses optimistic retry on unique constraint collision (handles concurrency). Future: scheduled chain verification & archival (Phase 2).

## Error & Observability
Sentry enabled in production when DSN present (scripts permitted by CSP via nonce + strict-dynamic). Server timing header surfaces loader/render timings.

## Remaining Gaps (Critical for Production)
1. Audit read RBAC + redaction (PHI minimization) pending.
2. PHI data classification & encryption at rest decision (SQLite vs Postgres with TDE/KMS).
3. File upload malware scanning & strict MIME enforcement.
4. CSP reporting endpoint (Report-To / report-uri) for violation telemetry.
5. Secrets management & rotation policy (central vault). 

## Change Log (Security Relevant)
2025-10-06: Re-hardened CSP (removed temporary unsafe-inline fallback) using nonce + strict-dynamic; added additional security headers.

---
For implementation specifics see inline comments in `app/entry.server.tsx` and `server/index.ts`.
