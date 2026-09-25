# Fidensa web application foundation

This repository contains the Next.js and TypeScript website foundation plus the protected application database contract. Its public route copy is intentionally neutral and temporary. Provider mutations, deployment, and final legal/product content remain outside this repository state.

## Supported toolchain

- Node.js 24.21.x (validated against 24.21.0)
- npm 11.19.x (validated against 11.19.0)
- Next.js 16.3.6

The exact dependency graph is recorded in `package-lock.json`. The repository uses npm only and carries one dependency lockfile.

## Deterministic commands

```sh
npm ci --cache /tmp/fidensa-web-npm-cache
npm run dev
npm run build
npm run lint
npm run format:check
npm run typecheck
npm test
npm run inspect
npm run verify:routes
npm run verify
```

`npm run verify` is the complete repository check. `npm run build` supplies bounded test defaults only when neither `APP_ENV` nor a Vercel environment identity exists. A staged or production-class build must provide its explicit configuration and never inherits those defaults. The route verifier starts the already-built server on loopback and executes the versioned GET/HEAD route manifest.

The machine's user-level npm cache is not part of the repository. A writable disposable cache can be supplied with `--cache` as shown for clean installation.

## Configuration boundaries

`.env.example` contains only public or non-sensitive local settings. Code intended to access privileged provider configuration lives under `src/server`, imports the Next.js `server-only` guard, and is not imported by client components.

Local and test environments accept only synthetic/deterministic provider posture and captured delivery. Staged-production and production builds require HTTPS, immutable build/deployment/configuration identities, and production provider posture. Build validation rejects provider-prefixed or sensitive public names and public values that duplicate any supplied server credential material. The server-only credential categories are validated by `getServerConfig()` at first privileged use; no privileged provider operation exists in this foundation. Future adapters must obtain configuration through that fail-closed function before doing work. Validation errors identify a category but never echo a supplied value.

Evidence state is closed: absent, unknown, contradictory, or attempted accepted input resolves to the application-only presentation. Public evidence publication remains deliberately unavailable here.

### Controlled-exercise integration obligations

The local acceptance helpers are deliberately not wired to a public route or a
live provider in this tree. `TASK-02-006` must seal the redacted immutable
`CE-02-v1.0` packet and call `validateControlledEvidencePacket` before creating
or advancing its candidate acceptance record. Any validation error stops the
exercise; the task must persist the exact validated packet bytes and digest,
and must recapture rather than edit an accepted packet. No Shareable Link,
Automation Bypass, fixture-verifier, provider, or other bearer value may be
passed to the validator as evidence content.

`TASK-02-008` must instantiate the server-only Resend contact provider with the
separately provisioned management credential, call
`removeExerciseMarketingContact` for the exercise control's exact recipient,
and require its absent-contact/absent-topic read-back before invoking database
cleanup. A provider error or persisting contact/topic state leaves the exercise
protected, intake closed, marketing ineligible, and cleanup pending. Only then
may the operator call the correlation-bound `cleanup_exercise` operation and
record the immutable cleanup result. These are safe integration obligations,
not authorization for this repository task to deploy, configure credentials,
call a live provider, or apply a remote migration.

## Security and privacy defaults

`next.config.ts` applies the fixed non-CSP baseline to every response, including framework-served assets. `proxy.ts` adds the versioned per-response CSP and route-class cache policy to application and error responses. Test uses production CSP semantics; local development adds only the loopback/eval allowances required for hot reload. HSTS is emitted only for HTTPS production-class requests. Application HTML and error responses are `no-store`; fingerprinted public assets may retain immutable caching.

Structured logging is allowlisted. Arbitrary request bodies, headers, query strings, addresses, answers, credentials, tokens, and provider responses are not accepted by the log record constructor. No visitor analytics, advertising, session replay, Web Analytics, or Speed Insights integration is installed.

## Database migrations

Database changes belong in `migrations/` and follow its documented naming and review convention. The protected application schema is defined there and is exercised only against isolated local database instances by this repository's verification commands.

## Compatibility and accessibility

The shell uses semantic landmarks, visible keyboard focus, responsive layout, reduced-motion handling, and no color-only status. No browser matrix or accessibility certification is claimed here. Release compatibility remains gated on the later operator-approved versioned matrix and independent observations required by the architecture contract.
