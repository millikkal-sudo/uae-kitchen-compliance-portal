create extension if not exists pgcrypto;

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_id text not null unique,
  name text not null,
  department text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.certificates (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id) on delete cascade,
  type text not null check (type in ('bfs', 'ohc')),
  issue_date date,
  expiry_date date,
  file_name text,
  file_type text,
  file_size bigint,
  file_data_url text,
  updated_at timestamptz not null default now(),
  unique (employee_id, type)
);

create table if not exists public.portal_settings (
  id text primary key default 'default',
  reminder_days integer not null default 30,
  manager_email text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.employees enable row level security;
alter table public.certificates enable row level security;
alter table public.portal_settings enable row level security;

drop policy if exists "authenticated users can read employees" on public.employees;
drop policy if exists "authenticated users can insert employees" on public.employees;
drop policy if exists "authenticated users can update employees" on public.employees;
drop policy if exists "authenticated users can delete employees" on public.employees;
drop policy if exists "authenticated users can read certificates" on public.certificates;
drop policy if exists "authenticated users can insert certificates" on public.certificates;
drop policy if exists "authenticated users can update certificates" on public.certificates;
drop policy if exists "authenticated users can delete certificates" on public.certificates;
drop policy if exists "authenticated users can read portal settings" on public.portal_settings;
drop policy if exists "authenticated users can insert portal settings" on public.portal_settings;
drop policy if exists "authenticated users can update portal settings" on public.portal_settings;

create policy "authenticated users can read employees"
  on public.employees for select to authenticated using (true);
create policy "authenticated users can insert employees"
  on public.employees for insert to authenticated with check (true);
create policy "authenticated users can update employees"
  on public.employees for update to authenticated using (true) with check (true);
create policy "authenticated users can delete employees"
  on public.employees for delete to authenticated using (true);

create policy "authenticated users can read certificates"
  on public.certificates for select to authenticated using (true);
create policy "authenticated users can insert certificates"
  on public.certificates for insert to authenticated with check (true);
create policy "authenticated users can update certificates"
  on public.certificates for update to authenticated using (true) with check (true);
create policy "authenticated users can delete certificates"
  on public.certificates for delete to authenticated using (true);

create policy "authenticated users can read portal settings"
  on public.portal_settings for select to authenticated using (true);
create policy "authenticated users can insert portal settings"
  on public.portal_settings for insert to authenticated with check (true);
create policy "authenticated users can update portal settings"
  on public.portal_settings for update to authenticated using (true) with check (true);

insert into public.portal_settings (id, reminder_days, manager_email)
values ('default', 30, '')
on conflict (id) do nothing;
