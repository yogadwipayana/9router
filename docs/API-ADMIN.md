# 9Router Admin API

Dokumentasi endpoint admin yang dipakai oleh aplikasi external (sidebar management) — usage stats, users, API keys, models, dan pricing.

Semua endpoint terdaftar di `/api/v1/admin/*` dan juga terekspos via alias `/v1/admin/*` (Next.js rewrite).

---

## Authentication

Semua endpoint di bawah `/admin/*` butuh `ADMIN_API_KEY` yang diset di `.env`:

```env
ADMIN_API_KEY=change-me-to-a-separate-admin-api-key
```

Kirim key dengan **salah satu** cara berikut:

| Header | Format |
|---|---|
| `Authorization` | `Bearer <ADMIN_API_KEY>` |
| `x-admin-api-key` | `<ADMIN_API_KEY>` |

Validasi pakai constant-time compare (`crypto.timingSafeEqual` setelah SHA-256).

### Auth error responses

| Status | Body | Kapan |
|---|---|---|
| `401` | `{ "error": "Missing API key" }` | Tidak ada `Authorization` / `x-admin-api-key` |
| `401` | `{ "error": "Invalid admin API key" }` | Key salah |
| `503` | `{ "error": "Admin API key is not configured" }` | `ADMIN_API_KEY` belum diset di `.env` server |

### CORS

Semua admin endpoint balas CORS headers:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
Access-Control-Allow-Headers: *
```

Tiap path mendukung `OPTIONS` preflight (return `204` tanpa auth).

> **Penting**: walau `Allow-Origin: *`, jangan pakai `ADMIN_API_KEY` langsung dari browser publik — ini key sensitif level admin. Pakai dari server-to-server, CLI, atau backend internal saja.

---

## Base URL

| Path | Catatan |
|---|---|
| `/v1/admin/*` | Disarankan untuk klien external (alias OpenAI-style) |
| `/api/v1/admin/*` | Path Next.js asli |

Contoh production:

```
https://your-9router-host/v1/admin/users
```

---

## Endpoint summary

| Method | Path | Deskripsi |
|---|---|---|
| GET | `/v1/admin/usage` | Usage stats + chart + recent logs + request details |
| GET | `/v1/admin/users` | List semua user |
| POST | `/v1/admin/users` | Buat / upsert user |
| GET | `/v1/admin/users/{email}` | Get satu user |
| PATCH | `/v1/admin/users/{email}` | Update user |
| POST | `/v1/admin/users/{email}` | Action: `add-budget`, `reset-usage` |
| DELETE | `/v1/admin/users/{email}` | Hapus user budget |
| GET | `/v1/admin/api-keys` | List API keys |
| POST | `/v1/admin/api-keys` | Buat API key baru |
| GET | `/v1/admin/api-keys/{id}` | Get satu API key |
| PATCH | `/v1/admin/api-keys/{id}` | Update API key |
| DELETE | `/v1/admin/api-keys/{id}` | Hapus API key |
| GET | `/v1/admin/models` | Get model catalog (management/public) |
| PUT | `/v1/admin/models/alias` | Set/update alias model |
| GET | `/v1/admin/pricing` | Get pricing config |
| PATCH | `/v1/admin/pricing` | Update pricing config |
| DELETE | `/v1/admin/pricing` | Reset pricing (all / per-provider / per-model) |

---

## Usage

### `GET /v1/admin/usage`

Mengembalikan data dashboard Usage: stats, chart, recent logs, request details paginated, dan daftar provider yang muncul di hasil.

**Query parameters**

| Name | Type | Default | Range / Enum |
|---|---|---|---|
| `period` | string | `7d` | `today`, `24h`, `7d`, `30d`, `60d`, `all` |
| `page` | integer | `1` | 1–999999 (out-of-range → clamped, no error) |
| `pageSize` | integer | `20` | 1–100 (out-of-range → clamped, no error) |
| `logsLimit` | integer | `200` | 0–500 (0 = skip, out-of-range → clamped) |
| `provider` | string | — | filter request details |
| `model` | string | — | filter request details |
| `connectionId` | string | — | filter request details |
| `status` | string | — | filter request details |
| `startDate` | string | — | filter request details (ISO date) |
| `endDate` | string | — | filter request details (ISO date) |

> **Catatan validasi**: angka di luar range akan **di-clamp diam-diam** (bukan 400). Hanya `period` yang invalid yang balas 400. Pass `page=0` jadi `1`, `pageSize=999` jadi `100`, dst.

> **`chartPeriod`**: kalau `period=all`, chart pakai window `60d` (tidak ada chart "all"). Field `chartPeriod` di response menunjukkan window aktual yang dipakai untuk chart, bisa beda dengan `period`.

**Response 200** (shape, isi tergantung database):

```json
{
  "period": "7d",
  "chartPeriod": "7d",
  "stats": { /* getUsageStats(period) */ },
  "chart": { /* getChartData(chartPeriod) */ },
  "logs": [ /* getRecentLogs(logsLimit) */ ],
  "requestDetails": {
    "details": [ /* … */ ],
    "total": 0,
    "page": 1,
    "pageSize": 20
  },
  "providers": [
    { "id": "openai", "name": "OpenAI" }
  ]
}
```

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Invalid period" }` |
| `500` | `{ "error": "Failed to fetch usage" }` |

---

## Users

User di sini adalah **owner user** untuk routing API keys (punya budget USD).

### `GET /v1/admin/users`

**Response 200**

```json
{
  "users": [
    {
      "email": "user@example.com",
      "budgetUsd": 25,
      "spentUsd": 1.2345,
      "remainingUsd": 23.7655,
      "isActive": true,
      "configured": true,
      "keyCount": 3,
      "requestCount": 142,
      "createdAt": "2026-06-04T01:23:45.000Z",
      "updatedAt": "2026-06-04T01:23:45.000Z"
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `email` | string | Lowercased |
| `budgetUsd` | number \| null | `null` kalau user tidak ada di tabel `ownerUsers` (muncul karena ada API key dengan owner ini) |
| `spentUsd` | number | Sum cost dari `usageHistory` |
| `remainingUsd` | number \| null | `max(0, budgetUsd - spentUsd)`, `null` kalau `budgetUsd` null |
| `isActive` | boolean | |
| `configured` | boolean | `true` kalau ada row di `ownerUsers`, `false` kalau hanya muncul dari API key/usage |
| `keyCount` | integer | Jumlah API key milik user |
| `requestCount` | integer | Jumlah request di window penuh |
| `createdAt` / `updatedAt` | string \| null | ISO timestamp, `null` untuk user yang belum `configured` |

**Errors**

| Status | Body |
|---|---|
| `500` | `{ "error": "Failed to fetch users" }` |

---

### `POST /v1/admin/users`

Buat atau upsert user baru.

**Request body**

```json
{
  "email": "user@example.com",
  "budgetUsd": 25,
  "isActive": true
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `email` | string | yes | Akan di-lowercase + trim. Harus match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| `budgetUsd` | number | yes | ≥ 0 |
| `isActive` | boolean | no | Default `true` (hanya `false` yang dianggap nonaktif) |

**Response 201**

```json
{
  "user": {
    "email": "user@example.com",
    "budgetUsd": 25,
    "isActive": true,
    "configured": true,
    "createdAt": "2026-06-04T01:23:45.000Z",
    "updatedAt": "2026-06-04T01:23:45.000Z"
  }
}
```

> Upsert: kalau email sudah ada, row diperbarui (tetap balas `201`).

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Valid email is required" }` |
| `400` | `{ "error": "Budget must be a non-negative number" }` |
| `500` | `{ "error": "<message>" }` |

---

### `GET /v1/admin/users/{email}`

`email` di path **harus URL-encoded** (`@` jadi `%40`).

**Response 200**

```json
{
  "user": {
    "email": "user@example.com",
    "budgetUsd": 25,
    "spentUsd": 3.21,
    "remainingUsd": 21.79,
    "isActive": true,
    "configured": true,
    "keyCount": 3,
    "requestCount": 142,
    "createdAt": "2026-06-04T01:23:45.000Z",
    "updatedAt": "2026-06-04T01:23:45.000Z"
  }
}
```

Shape sama seperti item di `GET /v1/admin/users`. `404` dipicu kalau `configured === false` (user tidak ada di tabel `ownerUsers`, walau email mungkin punya API key).

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Valid email is required" }` |
| `404` | `{ "error": "User budget not found" }` |

---

### `PATCH /v1/admin/users/{email}`

Update budget / status user.

**Request body**

```json
{
  "budgetUsd": 50,
  "isActive": true
}
```

| Field | Type | Required |
|---|---|---|
| `budgetUsd` | number | yes (≥ 0) |
| `isActive` | boolean | no (default `true`) |

**Response 200**

```json
{
  "user": {
    "email": "user@example.com",
    "budgetUsd": 50,
    "isActive": true,
    "configured": true,
    "createdAt": "2026-06-04T01:23:45.000Z",
    "updatedAt": "2026-06-04T01:23:45.000Z"
  }
}
```

> PATCH bersifat **upsert**: kalau email belum ada, akan dibuat baru (tidak balas 404).

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Valid email is required" }` |
| `400` | `{ "error": "Budget must be a non-negative number" }` |
| `500` | `{ "error": "<message>" }` |

---

### `POST /v1/admin/users/{email}`

Eksekusi action.

**Request body — `add-budget`**

```json
{ "action": "add-budget", "amountUsd": 10 }
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `action` | string | yes | `"add-budget"` |
| `amountUsd` | number | yes | > 0 (strict) |

**Request body — `reset-usage`**

```json
{ "action": "reset-usage" }
```

> **Destructive**: menghapus semua usage history milik key user dan rebuild aggregate harian. Tidak ada undo.

**Response 200 — `add-budget`**

Balas state user lengkap (sama seperti `GET /v1/admin/users/{email}`):

```json
{
  "user": {
    "email": "user@example.com",
    "budgetUsd": 35,
    "spentUsd": 3.21,
    "remainingUsd": 31.79,
    "isActive": true,
    "configured": true,
    "keyCount": 3,
    "requestCount": 142,
    "createdAt": "2026-06-04T01:23:45.000Z",
    "updatedAt": "2026-06-04T15:00:00.000Z"
  }
}
```

**Response 200 — `reset-usage`**

```json
{
  "user": { /* state user setelah reset */ },
  "reset": { /* hasil resetUsageForOwner */ }
}
```

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Valid email is required" }` |
| `400` | `{ "error": "Amount must be greater than zero" }` |
| `400` | `{ "error": "Unsupported user action" }` |
| `404` | `{ "error": "User budget not found" }` |
| `500` | `{ "error": "<message>" }` |

---

### `DELETE /v1/admin/users/{email}`

**Response 200**

```json
{ "message": "User budget removed" }
```

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Valid email is required" }` |
| `404` | `{ "error": "User budget not found" }` |
| `500` | `{ "error": "Failed to delete user" }` |

---

## API Keys

API key user-scoped untuk routing endpoint `/v1/chat/completions`, `/v1/messages`, dll. Bukan `ADMIN_API_KEY`.

### `GET /v1/admin/api-keys`

**Response 200**

```json
{
  "keys": [
    {
      "id": "uuid-or-id",
      "name": "External app key",
      "key": "sk-…",
      "owner": "user@example.com",
      "userEmail": "user@example.com",
      "machineId": "<server-machine-id>",
      "isActive": true,
      "createdAt": "2026-06-04T01:23:45.000Z"
    }
  ]
}
```

> Raw key (`key`) selalu dikembalikan **tanpa masking** di endpoint manapun (list, get, create). Anggap setiap response admin api-keys sebagai sensitif.

**Errors**

| Status | Body |
|---|---|
| `500` | `{ "error": "Failed to fetch API keys" }` |

---

### `POST /v1/admin/api-keys`

**Request body**

```json
{
  "name": "External app key",
  "owner": "user@example.com"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Trimmed, tidak boleh kosong |
| `owner` | string (email) | no | User harus sudah ada (`POST /admin/users` dulu). Lower-cased. |
| `userEmail` | string (email) | no | Alias dari `owner` (`userEmail` diutamakan kalau dua-duanya dikirim) |

> Owner key milik user → dipakai untuk billing budget. Tanpa owner → routing key tanpa scope user.
> `machineId` selalu di-generate server, tidak dari client.

**Response 201**

```json
{
  "key": "sk-…",
  "name": "External app key",
  "id": "uuid-or-id",
  "owner": "user@example.com",
  "userEmail": "user@example.com",
  "machineId": "<server-machine-id>"
}
```

> Field `key` adalah raw key. Endpoint GET di bawah juga balas raw `key` (tidak ada masking) — perlakukan semua respon admin api-keys sebagai sensitif.

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Name is required" }` |
| `400` | `{ "error": "Owner must be a valid email" }` |
| `400` | `{ "error": "Create this user before assigning API keys" }` |
| `500` | `{ "error": "Failed to create API key" }` |

---

### `GET /v1/admin/api-keys/{id}`

**Response 200**

```json
{
  "key": {
    "id": "uuid-or-id",
    "name": "External app key",
    "key": "sk-…",
    "owner": "user@example.com",
    "userEmail": "user@example.com",
    "machineId": "<server-machine-id>",
    "isActive": true,
    "createdAt": "2026-06-04T01:23:45.000Z"
  }
}
```

> Sama seperti list — raw `key` di-return tanpa masking. `userEmail` adalah alias dari `owner` yang dihitung saat dibaca (bukan kolom DB tersendiri).

**Errors**

| Status | Body |
|---|---|
| `404` | `{ "error": "Key not found" }` |
| `500` | `{ "error": "Failed to fetch API key" }` |

---

### `PATCH /v1/admin/api-keys/{id}`

**Request body** (semua opsional, kirim hanya yang diubah)

```json
{
  "name": "Updated key name",
  "isActive": true,
  "owner": "newowner@example.com"
}
```

| Field | Type | Notes |
|---|---|---|
| `name` | string | Trimmed, tidak boleh kosong kalau dikirim |
| `isActive` | boolean | Hanya `false` yang dianggap nonaktif |
| `owner` | string (email) atau `""` | `""` = un-assign |
| `userEmail` | string (email) atau `""` | Alias dari `owner` |

**Response 200**

Shape sama seperti `GET /v1/admin/api-keys/{id}`:

```json
{
  "key": {
    "id": "uuid-or-id",
    "name": "Updated key name",
    "key": "sk-…",
    "owner": "newowner@example.com",
    "userEmail": "newowner@example.com",
    "machineId": "<server-machine-id>",
    "isActive": true,
    "createdAt": "2026-06-04T01:23:45.000Z"
  }
}
```

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Name must be a non-empty string" }` |
| `400` | `{ "error": "Owner must be a valid email" }` |
| `400` | `{ "error": "Create this user before assigning API keys" }` |
| `404` | `{ "error": "Key not found" }` |
| `500` | `{ "error": "Failed to update API key" }` |

---

### `DELETE /v1/admin/api-keys/{id}`

**Response 200**

```json
{ "message": "Key deleted successfully" }
```

**Errors**

| Status | Body |
|---|---|
| `404` | `{ "error": "Key not found" }` |
| `500` | `{ "error": "Failed to delete API key" }` |

---

## Models

### `GET /v1/admin/models`

**Query parameters**

| Name | Type | Default | Enum |
|---|---|---|---|
| `view` | string | `management` | `management`, `public` |

**Response 200 — `view=public`**

OpenAI-compatible list, hanya kind `llm`:

```json
{
  "object": "list",
  "data": [
    { "id": "openai/gpt-4o-mini", "object": "model", "owned_by": "openai", "kind": "llm" }
  ]
}
```

**Response 200 — `view=management`**

Catalog lengkap (provider sections, custom models, alias, dll). Shape mengikuti `buildModelManagementCatalog()`.

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Invalid view. Use management or public." }` |
| `500` | `{ "error": "Failed to fetch models" }` |

---

### `PUT /v1/admin/models/alias`

Set alias untuk model.

**Request body**

```json
{ "model": "openai/gpt-4o-mini", "alias": "fast-chat" }
```

| Field | Type | Required |
|---|---|---|
| `model` | string | yes (trimmed, non-empty) |
| `alias` | string | yes (trimmed, non-empty) |

> Re-setting alias yang sama untuk model yang sama (mis. `model=X, alias=Y` saat memang sudah `X→Y`) dianggap valid (no-op). Konflik hanya dilempar kalau alias sama dipakai oleh model **lain**.

**Response 200**

```json
{ "success": true, "model": "openai/gpt-4o-mini", "alias": "fast-chat" }
```

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Model and alias required" }` |
| `400` | `{ "error": "Alias already in use" }` |
| `500` | `{ "error": "Failed to update model alias" }` |

---

## Pricing

### `GET /v1/admin/pricing`

**Response 200**

Object per-provider per-model. Field harga dalam **USD per 1M tokens** sesuai konvensi 9Router.

```json
{
  "openai": {
    "gpt-4o-mini": { "input": 0.15, "output": 0.6, "cached": 0.075 }
  },
  "anthropic": {
    "claude-sonnet-4": { "input": 3, "output": 15, "cache_creation": 3.75, "reasoning": 0 }
  }
}
```

**Errors**

| Status | Body |
|---|---|
| `500` | `{ "error": "Failed to fetch pricing" }` |

---

### `PATCH /v1/admin/pricing`

Merge update ke pricing config. Pakai shape sama seperti GET.

**Allowed pricing fields** per model:

- `input`
- `output`
- `cached`
- `reasoning`
- `cache_creation`

Semua harus number ≥ 0 (NaN ditolak).

**Request body**

```json
{
  "openai": {
    "gpt-4o-mini": { "input": 0.15, "output": 0.6, "cached": 0.075 }
  }
}
```

**Response 200**

Pricing config setelah update (shape sama seperti GET).

**Errors**

| Status | Body |
|---|---|
| `400` | `{ "error": "Invalid pricing data format" }` |
| `400` | `{ "error": "Invalid pricing for provider: <name>" }` |
| `400` | `{ "error": "Invalid pricing for model: <provider>/<model>" }` |
| `400` | `{ "error": "Invalid pricing field: <key> for <provider>/<model>" }` |
| `400` | `{ "error": "Invalid pricing value for <key> in <provider>/<model>: must be non-negative number" }` |
| `500` | `{ "error": "Failed to update pricing" }` |

---

### `DELETE /v1/admin/pricing`

Reset pricing. Scope ditentukan oleh query.

**Query parameters**

| `provider` | `model` | Efek |
|---|---|---|
| set | set | Reset satu model (`provider/model`) |
| set | — | Reset seluruh provider |
| — | — | Reset **semua** pricing |
| — | set | Reset **semua** pricing (param `model` tanpa `provider` diabaikan) |

> Tanpa `provider` = reset full. Hati-hati. Mengirim `model` tanpa `provider` **tidak** menghasilkan error — sebagai gantinya, full reset tetap dijalankan.

**Response 200**

Pricing config setelah reset (shape sama seperti GET).

**Errors**

| Status | Body |
|---|---|
| `500` | `{ "error": "Failed to reset pricing" }` |

---

## Common error response shape

Semua error JSON ikut shape:

```json
{ "error": "<human-readable message>" }
```

Beberapa endpoint tambahkan field tambahan (mis. `retryAfter` di rate-limit endpoint lain), tapi semua admin endpoint hanya mengembalikan `error`.

---

## Contoh client

### cURL

```bash
# List users
curl https://your-9router/v1/admin/users \
  -H "Authorization: Bearer $ADMIN_API_KEY"

# Buat user
curl https://your-9router/v1/admin/users \
  -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","budgetUsd":25}'

# Top-up budget
curl https://your-9router/v1/admin/users/user%40example.com \
  -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"add-budget","amountUsd":10}'

# Buat routing API key untuk user
curl https://your-9router/v1/admin/api-keys \
  -X POST \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"External app","owner":"user@example.com"}'
```

### Node (fetch)

```js
const ADMIN = process.env.ADMIN_API_KEY;
const BASE = "https://your-9router/v1/admin";

async function listUsers() {
  const res = await fetch(`${BASE}/users`, {
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}

async function createUser(email, budgetUsd) {
  const res = await fetch(`${BASE}/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ADMIN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, budgetUsd }),
  });
  if (!res.ok) throw new Error((await res.json()).error);
  return res.json();
}
```

---

## Catatan untuk integrasi

1. **`ADMIN_API_KEY` ≠ user routing API key.** Admin key untuk manajemen, routing key untuk panggil `/v1/chat/completions` dll.
2. **CORS terbuka (`*`)** tapi `ADMIN_API_KEY` jangan di-expose ke browser publik.
3. **Semua email di-normalize** (lowercase + trim) sebelum disimpan/dicari.
4. **Email di path harus URL-encoded** (`@` → `%40`).
5. **`reset-usage` dan `DELETE /admin/pricing` tanpa query bersifat destruktif** dan tidak ada undo.
6. **Rate limiting**: admin endpoint sendiri tidak punya rate limiter (login limiter terpisah, hanya untuk dashboard login). Lindungi key, jangan mass-call dari client tidak terpercaya.
