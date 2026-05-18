# Supabase Setup

This folder contains the first production database bootstrap for the Snitch backend.

The current Node server stores state in `server/data/platform-db.json`. The initial Supabase schema intentionally keeps that same shape in one durable `jsonb` row so the beta can move to hosted Postgres without a broad rewrite of every API route. After beta, high-traffic collections can be split into normalized tables.

## Create The Project

1. Go to Supabase and create a new project.
2. Recommended region: pick the closest region to the beta users and Render backend.
3. Save these values:
   - `DATABASE_URL`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_ANON_KEY`

## Run The Migration

Open Supabase SQL Editor and run:

```sql
-- paste supabase/migrations/0001_initial_platform_state.sql
```

This creates:

- `public.platform_state`: one durable JSON document matching the existing backend store.
- `public.platform_events`: append-only audit/event log for future operations.
- `snitch-evidence`: private Supabase Storage bucket for raw video/audio/frame/case-packet assets.

## Backend Env

For Render, add:

```bash
DATABASE_URL=postgresql://...
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_STORAGE_BUCKET=snitch-evidence
SNITCH_STORE_DRIVER=supabase
```

Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only. Do not ship it in the mobile app or CRM.

## Next Backend Work

1. Add a Postgres-backed implementation behind `readPlatformData` / `writePlatformData`.
2. Add Supabase Storage asset writes behind `saveAsset`, `removeAsset`, and `getAssetAbsolutePath`.
3. Import existing `data/platform-db.json` into `public.platform_state`.
4. Smoke test mobile signup, device registration, capture session, upload, finalize, processing, and CRM review.
