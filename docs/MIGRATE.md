# Menjalankan Migrasi Database

Panduan ini menjelaskan cara menjalankan migrasi Prisma terhadap database PostgreSQL (Supabase), termasuk langkah yang dipakai untuk mengisi branch kosong.

## Prasyarat

- Node.js + dependencies terpasang (`npm install`).
- Prisma 7 (`prisma` & `@prisma/client`), sudah ada di `devDependencies`/`dependencies`.
- Koneksi database tersedia lewat environment variable `DATABASE_URL`.

## Bagaimana koneksi dikonfigurasi

Prisma membaca config dari `prisma.config.mjs`:

```js
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: env("DATABASE_URL") },
});
```

Artinya datasource untuk migrasi diambil dari `DATABASE_URL`. File `.env` menyediakan dua bentuk koneksi Supabase:

- `DATABASE_URL` — koneksi **pooled** lewat pgbouncer (port `6543`, `?pgbouncer=true`). Dipakai aplikasi saat runtime.
- `DIRECT_URL` — koneksi **direct** (port `5432`). Dipakai untuk migrasi/DDL.

> Penting: jalankan migrasi lewat koneksi **direct** (port `5432`), bukan pooled (`6543`). pgbouncer dalam mode transaction pooling bisa menggagalkan operasi DDL/advisory lock yang dipakai Prisma.

## Langkah menjalankan migrasi (lewat terminal)

Langkah ini yang dipakai untuk menerapkan 5 migrasi ke branch yang masih kosong.

1. Cek status migrasi terhadap target database. Override `DATABASE_URL` ke koneksi direct branch tujuan:

   ```bash
   DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@<HOST>:5432/postgres" \
     npx prisma migrate status
   ```

   Output akan menampilkan migrasi yang belum diterapkan, contoh:

   ```
   5 migrations found in prisma/migrations
   Following migrations have not yet been applied:
   20260601134000_init
   20260604000000_add_enabled_models
   20260604020000_drop_request_details
   20260605000000_add_owner_to_usage_history
   20260605000000_add_pricing
   ```

2. Terapkan migrasi dengan `migrate deploy` (non-interaktif, hanya menjalankan migrasi yang sudah ada — tidak membuat migrasi baru):

   ```bash
   DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@<HOST>:5432/postgres" \
     npx prisma migrate deploy
   ```

   Hasil yang diharapkan:

   ```
   The following migration(s) have been applied:
   ...
   All migrations have been successfully applied.
   ```

3. Verifikasi schema sudah sinkron:

   ```bash
   DATABASE_URL="postgresql://postgres.<PROJECT_REF>:<PASSWORD>@<HOST>:5432/postgres" \
     npx prisma migrate status
   ```

   Output: `Database schema is up to date!`

> Di PowerShell, set variable per-perintah pakai:
> `$env:DATABASE_URL="..."; npx prisma migrate deploy`
> (atau cukup andalkan `DATABASE_URL` yang sudah ada di `.env`, karena `prisma.config.mjs` me-load `dotenv/config`).

## `migrate deploy` vs `migrate dev`

- `npx prisma migrate deploy` — untuk menerapkan migrasi yang sudah ada (CI/produksi/branch). Tidak membuat file migrasi baru. **Ini yang dipakai di sini.**
- `npx prisma migrate dev` — untuk pengembangan lokal: membuat migrasi baru dari perubahan schema lalu menerapkannya. Jangan dipakai di database produksi/shared.

## Script npm yang tersedia

```
npm run prisma:generate   # prisma generate
npm run prisma:validate   # prisma validate
npm run prisma:migrate    # prisma migrate dev  (buat + terapkan migrasi baru, lokal)
npm run prisma:deploy     # prisma migrate deploy (terapkan migrasi yang ada)
npm run prisma:studio     # prisma studio
```

Untuk target database tertentu (mis. branch), override `DATABASE_URL` di depan perintah seperti pada langkah di atas.

1. step to add voucher table
npx prisma migrate resolve --applied 20260604000000_add_enabled_models

$env:DATABASE_URL="postgresql://postgres.ftoodtlxohlczkzqxoys:[PASS]@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"; npx prisma migrate deploy

NOTE:

$env:DATABASE_URL="postgresql://postgres.ftoodtlxohlczkzqxoys:[PASS]@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"; npx prisma migrate deploy

node -r dotenv/config scripts/import-backup.mjs "C:\Users\YOGA\Documents\architecture\backup.sql"