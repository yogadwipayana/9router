# 9Router Security Audit

A source-level security review of the 9Router application (web dashboard, LLM proxy,
OAuth/credential import, tunnel management, and MITM subsystem). Findings are grounded
in the actual code and, where noted, verified experimentally.

- Scope: `src/**`, `custom-server.js`, `start.sh`, `Dockerfile`, deployment config.
- Method: manual code review of auth, authorization, proxy/SSRF, OAuth/secrets,
  command execution, the data layer, and the MITM proxy.
- Legend: **Critical / High / Medium / Low / Info**.

> Note: This document describes potential weaknesses for remediation. Impact of several
> items depends on deployment mode (Docker vs. bare `server.js`) and on the `requireLogin`
> setting, which defaults to `true`.

---

## Summary table

| # | Severity | Title | Primary location |
|---|----------|-------|------------------|
| 1 | High | Spoofable "trusted" client-IP / locality headers on bare `server.js` deploys | `custom-server.js`, `src/lib/auth/loginLimiter.js`, `src/dashboardGuard.js` |
| 2 | High | Weak default password `123456` not enforced away server-side | `src/lib/auth/dashboardSession.js`, `src/app/api/auth/login/route.js` |
| 3 | High | Sudo/root password stored with reversible encryption keyed on a non-secret | `src/mitm/manager.js` |
| 4 | Medium | SSRF filter bypasses in `/v1/web/fetch` | `src/shared/utils/ssrfGuard.js`, `src/sse/handlers/fetch.js` |
| 5 | Medium | Provider secrets and API keys stored in plaintext at rest | `src/lib/db/repos/connectionsRepo.js`, `apiKeysRepo.js` |
| 6 | Medium | SSRF with response reflection in GitLab PAT / dynamic OAuth | `src/app/api/oauth/gitlab/pat/route.js`, `src/app/api/oauth/[provider]/[action]/route.js` |
| 7 | Medium | Authenticated SSRF via proxy-test endpoint | `src/app/api/settings/proxy-test/route.js` |
| 8 | Low | Admin API CORS `Access-Control-Allow-Origin: *` | `src/lib/adminApiAuth.js` |
| 9 | Low | In-memory login limiter: restart reset + shared `unknown` bucket | `src/lib/auth/loginLimiter.js` |
| 10 | Low | Arbitrary env injection into `~/.claude/settings.json` | `src/app/api/cli-tools/claude-settings/route.js` |
| 11 | Info | String-built SQL in Cursor auto-import CLI fallback | `src/app/api/oauth/cursor/auto-import/route.js` |

---

## High

### 1. Spoofable "trusted" client-IP / locality headers on bare `server.js` deploys

The entire trust model depends on `custom-server.js` deriving the client IP from the TCP
socket and stripping/re-stamping `x-9r-real-ip`, `x-forwarded-for`, and `x-9r-via-proxy`.
The Docker image runs `node custom-server.js`, so this holds there. However, `start.sh`
(the documented pm2 / bare-metal path) launches `.next/standalone/server.js` directly:

```sh
PORT=4000 pm2 start node --name "9router" -- .next/standalone/server.js
```

In that mode `custom-server.js` never runs, so the `x-9r-*` headers are fully
attacker-controlled.

- **Login lockout bypass** — `src/lib/auth/loginLimiter.js` `getClientIp()` trusts
  `x-9r-real-ip` first ("client cannot spoof"). On a bare `server.js` deploy an attacker
  rotates `x-9r-real-ip` per request, giving a fresh lockout bucket every time and
  defeating the progressive lockout entirely (unlimited dashboard brute-force).
- **Forced locality** — `src/dashboardGuard.js` `isLocalRequest()` returns `true` when
  `x-9r-real-ip` is loopback and `x-9r-via-proxy` is absent. Spoofing
  `x-9r-real-ip: 127.0.0.1` makes a remote request appear local, opening
  `LOCAL_ONLY_PATHS` (e.g. `tailscale-install`, `kiro/cursor auto-import`,
  `reset-password`) when `requireLogin=false` or when combined with a valid session.

**Recommendation:** Do not trust `x-9r-*` headers unless the peer is a known reverse
proxy. Make the trusted-proxy handling mandatory regardless of entrypoint (fold
`custom-server.js` logic into the app or refuse to honor the headers when unset), and key
rate-limiting on the real socket address inside the Next runtime. Update `start.sh` to use
`custom-server.js`.

### 2. Weak default password `123456` not enforced away server-side

`src/lib/auth/dashboardSession.js` defines `DEFAULT_PASSWORD = "123456"`, and
`src/app/api/auth/login/route.js` falls back to `process.env.INITIAL_PASSWORD || "123456"`
when no password hash is stored:

```js
} else if (emailValid) {
  const initialPassword = process.env.INITIAL_PASSWORD || "123456";
  isValid = password === initialPassword;
}
```

Login therefore succeeds with `INITIAL_EMAIL` + `123456`. The response contains
`mustChangePassword` for remote clients, but that flag is advisory only — the `auth_token`
cookie is still issued, so the server does not block continued use of the default. Combined
with finding #1 this is remotely brute-forceable on bare deploys.

**Recommendation:** Refuse to establish a session while the default password is in effect on
a non-local request; require a real password at bootstrap (fail closed if `INITIAL_PASSWORD`
is unset and no hash exists). Use a constant-time comparison for the fallback path.

### 3. Sudo/root password stored with reversible encryption keyed on a non-secret

`src/mitm/manager.js` encrypts the operator's sudo password and persists it as
`settings.mitmSudoEncrypted`. The AES-256-GCM key is derived only from the machine ID plus
a hardcoded static salt:

```js
const ENCRYPT_SALT = "9router-mitm-pwd";
function deriveKey() {
  try {
    const { machineIdSync } = require("node-machine-id");
    const raw = machineIdSync();                       // /etc/machine-id — not secret
    return crypto.createHash("sha256").update(raw + ENCRYPT_SALT).digest();
  } catch {
    return crypto.createHash("sha256").update(ENCRYPT_SALT).digest();   // fully static key
  }
}
```

Two problems:

- The machine ID (`/etc/machine-id`, `/var/lib/dbus/machine-id`) is commonly world-readable
  and not a secret. Anyone with the settings DB plus host read access can re-derive the key
  and recover a **root-capable password**.
- The `catch` fallback returns `sha256(ENCRYPT_SALT)` — a fully static, publicly known key.

Because the DB can be a remote Postgres/Supabase instance and backups are plaintext, this
effectively makes the sudo password recoverable. Contrast the CLI-token derivation in
`src/shared/utils/machineId.js`, which correctly mixes in a random per-install `cli-secret`
file.

**Recommendation:** Derive the key from a random per-install secret (0600 file, like
`cli-secret`) combined with the machine ID; never fall back to a static-salt-only key.
Prefer not persisting the sudo password at all, or scope it to an OS keychain.

---

## Medium

### 4. SSRF filter bypasses in `/v1/web/fetch`

`src/shared/utils/ssrfGuard.js` `assertPublicUrl()` inspects only the literal hostname/IP;
it never resolves DNS and misses IPv4-mapped IPv6. Verified bypasses (any valid API key can
trigger `src/sse/handlers/fetch.js`):

- **DNS names resolving to internal IPs** — e.g. `http://127.0.0.1.nip.io/` passes the guard
  because no DNS resolution is performed. Attacker-controlled DNS can point at
  `169.254.169.254`, RFC1918 ranges, or loopback.
- **IPv6-mapped IPv4 (hex form)** — `http://[::ffff:127.0.0.1]/` normalizes to host
  `::ffff:7f00:1`, which the guard's regex `^::ffff:(\d+\.\d+\.\d+\.\d+)$` fails to match, so
  it reaches loopback.
- **No redirect protection** — a public URL that 302-redirects to an internal address is
  followed.

> Verified: single-number hosts like `http://2130706433/` and `http://0x7f000001/` are
> normalized by the WHATWG URL parser to `127.0.0.1` and are correctly blocked, so those
> encodings are *not* a bypass.

**Recommendation:** Resolve DNS and validate every resolved address (both A and AAAA),
block IPv4-mapped IPv6 generically, and re-validate on each redirect hop (or disable
redirects). Apply the same guard to all server-side fetches that accept user URLs.

### 5. Provider secrets and API keys stored in plaintext at rest

`src/lib/db/repos/connectionsRepo.js` serializes `apiKey`, `accessToken`, `refreshToken`,
and `idToken` into the `providerConnections.data` JSON column unencrypted.
`src/lib/db/repos/apiKeysRepo.js` stores the dashboard API key verbatim in the `key` column
and looks it up by equality (`WHERE key = ?`). Kiro import persists `clientId`/`clientSecret`
and iFlow persists a session cookie + provider API key, all in plaintext.

Since the DB can be a remote Postgres/Supabase instance and `exportDb` produces plaintext
backups, a DB or backup compromise leaks every upstream credential and every issued key.

**Recommendation:** Encrypt secret fields at rest (envelope encryption keyed off a random
server secret), and store dashboard API keys hashed (e.g. SHA-256) with an indexed lookup
instead of plaintext.

### 6. SSRF with response reflection in GitLab PAT / dynamic OAuth

`src/app/api/oauth/gitlab/pat/route.js` takes a user-supplied `baseUrl`, issues a
server-side request to it, and reflects the response body on failure:

```js
const base = (baseUrl?.trim() || GITLAB_DEFAULT_BASE).replace(/\/$/, "");
const userRes = await fetch(`${base}/api/v4/user`, { headers: { "Private-Token": token } });
if (!userRes.ok) {
  const err = await userRes.text();
  return NextResponse.json({ error: `GitLab token verification failed: ${err}` }, ...);
}
```

No SSRF guard is applied (unlike `/v1/web/fetch`). An authenticated user (or any caller when
`requireLogin=false`) can point `baseUrl` at internal services / cloud metadata and read the
response text back through the error. The dynamic `src/app/api/oauth/[provider]/[action]/route.js`
route similarly forwards arbitrary `meta` (documented to include `baseUrl`) into
`generateAuthData` / `exchangeTokens`.

**Recommendation:** Run these outbound URLs through the hardened SSRF guard and stop echoing
upstream response bodies to the client.

### 7. Authenticated SSRF via proxy-test endpoint

`src/app/api/settings/proxy-test/route.js` forwards arbitrary `proxyUrl` and `testUrl` to
`testProxyUrl` with no SSRF guard. Behind the dashboard this is admin-only, but with
`requireLogin=false` or a lower-trust session it enables internal-network probing.

**Recommendation:** Apply the SSRF guard to `testUrl`/`proxyUrl` and constrain schemes.

---

## Low / Informational

### 8. Admin API CORS `Access-Control-Allow-Origin: *`

`src/lib/adminApiAuth.js` returns `Access-Control-Allow-Origin: *` with
`Access-Control-Allow-Headers: *` on `/api/v1/admin/*`. This is acceptable because auth is a
non-cookie bearer token (a browser cannot attach the admin key cross-origin without knowing
it), but tightening to an allow-list is recommended defense-in-depth. **(Low)**

### 9. In-memory login limiter: restart reset + shared `unknown` bucket

`src/lib/auth/loginLimiter.js` keeps state in memory, so it resets on process restart. In
true direct-exposure mode all clients collapse into a single `"unknown"` bucket, meaning one
attacker's failures can lock out everyone else (minor DoS). **(Low)**

### 10. Arbitrary env injection into `~/.claude/settings.json`

`src/app/api/cli-tools/claude-settings/route.js` merges a client-supplied `env` object
straight into the user's Claude config file (only `typeof env === "object"` is checked). The
path is fixed (no traversal), but any key/value can be written, which could redirect the
Claude CLI base URL or inject env consumed by spawned tooling. Single-user, own-config, so
impact is limited. **(Low)**

### 11. String-built SQL in Cursor auto-import CLI fallback

`src/app/api/oauth/cursor/auto-import/route.js` `extractTokensViaCLI()` interpolates the key
into SQL (`WHERE key='${key}'`). Not exploitable today because `key` only comes from the
hardcoded `ACCESS_TOKEN_KEYS` / `MACHINE_ID_KEYS` constants, but use parameterized queries
for defense-in-depth. **(Info)**

---

## Verified strengths

The following controls were reviewed and found sound:

- **OIDC** (`src/lib/auth/oidc.js`, callback route) implements `state` + `nonce` + PKCE and
  verifies the `id_token` against the provider JWKS with issuer/audience/nonce checks.
- **Admin API key** comparison (`src/lib/adminApiAuth.js`) uses `SHA-256` + `crypto.timingSafeEqual`
  (constant-time, no length leak), and refuses access when `ADMIN_API_KEY` is unset. All
  `/api/v1/admin/*` handlers wrap logic in `withAdminApiKey`.
- **Middleware** (`src/proxy.js` → `dashboardGuard.js`) is deny-by-default for `/api/*` with
  an explicit public allow-list; `requireLogin` defaults to `true`.
- **JWT session secret** is auto-generated to a `0600` file when `JWT_SECRET` is unset;
  cookies are `httpOnly`, `sameSite=lax`, and `secure` under HTTPS.
- **CLI token** derivation mixes machine ID with a random per-install `cli-secret` (0600).
- **Tailscale/MITM command execution** passes the sudo password via stdin (never a shell
  string), rejects newlines on Linux, writes the install script to a temp file executed by
  path, and single-quote-escapes interpolated args (`shellQuoteSingle`).
- **Provider GET/PUT responses** strip `apiKey`/`accessToken`/`refreshToken`/`idToken`
  before returning to the browser.
- **`.env`** is covered by `.gitignore` (`.env*`) and is not tracked in git.
- **Cursor DB** is opened `readonly`.

---

## Remediation priority

1. **#1 spoofable trust headers** and **#3 reversible sudo password** — both allow escalation
   to host/root or defeat login protection on common deployments.
2. **#2 default `123456` password** not enforced away.
3. **#4 / #6 / #7 SSRF** — harden `ssrfGuard.js` (DNS + IPv6-mapped + redirects) and apply it
   to `gitlab/pat` and `proxy-test`.
4. **#5 plaintext secrets at rest** — encrypt provider secrets, hash dashboard API keys.
