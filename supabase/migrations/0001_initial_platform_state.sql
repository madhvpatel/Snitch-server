-- Snitch beta database bootstrap for Supabase Postgres.
-- This intentionally mirrors the current server/data/platform-db.json shape so
-- the backend can move from local JSON persistence to Supabase without a broad
-- route rewrite before the private beta.

create extension if not exists pgcrypto;

create table if not exists public.platform_state (
    id text primary key default 'default',
    version integer not null default 4,
    data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint platform_state_singleton check (id = 'default'),
    constraint platform_state_data_is_object check (jsonb_typeof(data) = 'object')
);

create table if not exists public.platform_events (
    id uuid primary key default gen_random_uuid(),
    actor_type text,
    actor_id text,
    event_type text not null,
    entity_type text,
    entity_id text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index if not exists platform_events_created_at_idx
    on public.platform_events (created_at desc);

create index if not exists platform_events_entity_idx
    on public.platform_events (entity_type, entity_id, created_at desc);

create index if not exists platform_state_data_gin_idx
    on public.platform_state using gin (data);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists set_platform_state_updated_at on public.platform_state;
create trigger set_platform_state_updated_at
before update on public.platform_state
for each row
execute function public.set_updated_at();

insert into public.platform_state (id, version, data)
values (
    'default',
    4,
    jsonb_build_object(
        'version', 4,
        'orgs', '[]'::jsonb,
        'orgUsers', '[]'::jsonb,
        'mobileUsers', '[]'::jsonb,
        'anonymousInstalls', '[]'::jsonb,
        'captureSessions', '[]'::jsonb,
        'submissions', '[]'::jsonb,
        'reports', '[]'::jsonb,
        'venues', '[]'::jsonb,
        'catalogTracks', '[]'::jsonb,
        'venueCoverage', '[]'::jsonb,
        'analystReviews', '[]'::jsonb,
        'sourceReviews', '[]'::jsonb,
        'casePackets', '[]'::jsonb,
        'assets', '[]'::jsonb,
        'contributors', '[]'::jsonb,
        'merchantMaster', '[]'::jsonb,
        'licenseStatus', '[]'::jsonb,
        'tariffTable', '[]'::jsonb,
        'caseLedger', '[]'::jsonb,
        'rewardLedger', '[]'::jsonb
    )
)
on conflict (id) do nothing;

-- Private media bucket for raw captures and generated evidence assets.
-- Keep this private; the Node backend should issue signed/read-through URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
    'snitch-evidence',
    'snitch-evidence',
    false,
    104857600,
    array[
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'audio/wav',
        'audio/mpeg',
        'image/jpeg',
        'image/png',
        'application/json',
        'application/zip',
        'application/octet-stream'
    ]
)
on conflict (id) do update
set
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

alter table public.platform_state enable row level security;
alter table public.platform_events enable row level security;

-- The backend should use SUPABASE_SERVICE_ROLE_KEY / direct DATABASE_URL.
-- No anon/client access is granted to these tables.
