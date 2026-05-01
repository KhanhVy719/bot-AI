create table if not exists public.bot_memory (
  id text primary key,
  schema_version integer not null default 1,
  memory text not null default '',
  recent jsonb not null default '[]'::jsonb,
  pending_turns integer not null default 0 check (pending_turns >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bot_memory_updated_at_idx
  on public.bot_memory (updated_at desc);

alter table public.bot_memory enable row level security;

comment on table public.bot_memory is
  'Long-term Discord bot memory. Access from the app server with SUPABASE_SERVICE_ROLE_KEY only.';
