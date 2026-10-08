create table public.ling_gateway_users (
 id uuid primary key default gen_random_uuid(), name text not null,
 role text not null default 'user' check(role in ('admin','user')),
 daily_limit integer check(daily_limit is null or daily_limit between 0 and 1000000),
 enabled boolean not null default true, created_at timestamptz not null default now()
);
create table public.ling_gateway_keys (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references public.ling_gateway_users(id),
 key_hash text unique not null, prefix text not null, name text not null,
 admin_access boolean not null default false, enabled boolean not null default true,
 created_at timestamptz not null default now(), expires_at timestamptz
);
create table public.ling_gateway_settings (
 id boolean primary key default true check(id), default_daily_limit integer not null default 20,
 owner_reserve integer not null default 100, max_output_tokens bigint default null,
 public_enabled boolean not null default false, monitor_hash text,
 check(default_daily_limit between 0 and 100000), check(owner_reserve between 0 and 100000),
 check(max_output_tokens is null or max_output_tokens between 1 and 9007199254740991)
);
insert into public.ling_gateway_settings(id) values(true);
create table public.ling_gateway_usage (
 user_id uuid not null references public.ling_gateway_users(id), day date not null,
 requests integer not null default 0, primary key(user_id,day)
);
create table public.ling_gateway_providers (
 id uuid primary key default gen_random_uuid(), name text not null, kind text not null,
 base_url text not null, secret_cipher jsonb, enabled boolean not null default false,
 priority integer not null default 10 check(priority between 0 and 10000),
 aliases jsonb not null default '{}', daily_limit integer check(daily_limit is null or daily_limit between 1 and 1000000),
 rpm_limit integer not null default 10 check(rpm_limit between 1 and 1000),
 failures integer not null default 0, open_until timestamptz, probe_until timestamptz,
 total_attempts bigint not null default 0, total_errors bigint not null default 0,
 latency_ms integer, last_status integer, checked_at timestamptz,
 created_at timestamptz not null default now(), check(kind in ('gemini','openrouter','cloudflare','custom'))
);
create table public.ling_gateway_provider_usage (
 provider_id uuid not null references public.ling_gateway_providers(id), day date not null,
 requests integer not null default 0, minute timestamptz, minute_requests integer not null default 0,
 primary key(provider_id,day)
);
create table public.ling_gateway_logs (
 id uuid primary key default gen_random_uuid(), user_id uuid references public.ling_gateway_users(id),
 model text not null, status text not null default 'pending', attempts jsonb not null default '[]',
 started_at timestamptz not null default now(), finished_at timestamptz,
 prompt_tokens integer, completion_tokens integer, refunded boolean not null default false
);
create index ling_gateway_logs_recent on public.ling_gateway_logs(started_at desc);
create index ling_gateway_logs_user on public.ling_gateway_logs(user_id,started_at desc);
create table public.ling_gateway_login_limits (
 ip_hash text primary key, window_start timestamptz not null default now(), attempts integer not null default 0
);

alter table public.ling_gateway_users enable row level security;
alter table public.ling_gateway_keys enable row level security;
alter table public.ling_gateway_settings enable row level security;
alter table public.ling_gateway_usage enable row level security;
alter table public.ling_gateway_providers enable row level security;
alter table public.ling_gateway_provider_usage enable row level security;
alter table public.ling_gateway_logs enable row level security;
alter table public.ling_gateway_login_limits enable row level security;
revoke all on public.ling_gateway_users,public.ling_gateway_keys,public.ling_gateway_settings,public.ling_gateway_usage,public.ling_gateway_providers,public.ling_gateway_provider_usage,public.ling_gateway_logs,public.ling_gateway_login_limits from anon,authenticated;
grant all on public.ling_gateway_users,public.ling_gateway_keys,public.ling_gateway_settings,public.ling_gateway_usage,public.ling_gateway_providers,public.ling_gateway_provider_usage,public.ling_gateway_logs,public.ling_gateway_login_limits to service_role;

create function public.ling_gateway_reserve(p_user uuid,p_model text) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare u public.ling_gateway_users; s public.ling_gateway_settings; n integer; d date; l uuid;
begin
 select * into u from public.ling_gateway_users where id=p_user for update;
 if u.id is null or not u.enabled then return jsonb_build_object('error','disabled'); end if;
 select * into s from public.ling_gateway_settings where id;
 if u.role<>'admin' and not s.public_enabled then return jsonb_build_object('error','public_closed');end if;
 d := (now() at time zone 'Asia/Shanghai')::date;
 insert into public.ling_gateway_usage(user_id,day) values(p_user,d) on conflict do nothing;
 select requests into n from public.ling_gateway_usage where user_id=p_user and day=d;
 if not (u.role='admin' and u.daily_limit is null) and n>=coalesce(u.daily_limit,s.default_daily_limit)
 then return jsonb_build_object('error','daily_quota_exceeded');end if;
 if (select count(*) from public.ling_gateway_logs where user_id=p_user and status='pending' and started_at>now()-interval '3 minutes')>=2
 then return jsonb_build_object('error','concurrency_limit');end if;
 update public.ling_gateway_usage set requests=requests+1 where user_id=p_user and day=d;
 insert into public.ling_gateway_logs(user_id,model) values(p_user,p_model) returning id into l;
 return jsonb_build_object('id',l,'day',d);
end $$;

create function public.ling_gateway_claim(p_provider uuid,p_admin boolean) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare p public.ling_gateway_providers; s public.ling_gateway_settings; q public.ling_gateway_provider_usage; d date; m timestamptz;
begin
 select * into p from public.ling_gateway_providers where id=p_provider for update;
 if not found or not p.enabled then return false;end if;
 if p.open_until>now() or p.probe_until>now() then return false;end if;
 select * into s from public.ling_gateway_settings where id;
 d := (now() at time zone 'Asia/Shanghai')::date; m := date_trunc('minute',now());
 insert into public.ling_gateway_provider_usage(provider_id,day) values(p_provider,d) on conflict do nothing;
 select * into q from public.ling_gateway_provider_usage where provider_id=p_provider and day=d for update;
 if p.daily_limit is not null and q.requests>=greatest(0,p.daily_limit-case when p_admin then 0 else least(s.owner_reserve,p.daily_limit/2) end) then return false;end if;
 if q.minute=m and q.minute_requests>=p.rpm_limit then return false;end if;
 update public.ling_gateway_provider_usage set requests=requests+1,minute=m,
 minute_requests=case when minute=m then minute_requests+1 else 1 end where provider_id=p_provider and day=d;
 if p.open_until is not null then update public.ling_gateway_providers set probe_until=now()+interval '130 seconds' where id=p_provider;end if;
 return true;
end $$;

create function public.ling_gateway_provider_result(p_provider uuid,p_status integer,p_latency integer,p_success boolean,p_health boolean default false,p_retry integer default 0) returns void
language plpgsql security invoker set search_path = '' as $$
begin
 update public.ling_gateway_providers set
 total_attempts=total_attempts+case when p_health then 0 else 1 end,
 total_errors=total_errors+case when not p_health and not p_success then 1 else 0 end,
 latency_ms=p_latency,last_status=p_status,checked_at=now(),
 failures=case when p_health then failures when p_success then 0 when p_status=429 or p_status>=500 or p_status in (0,401,403,404) then failures+1 else failures end,
 open_until=case when p_health then open_until when p_success then null
 when p_status=429 then now()+make_interval(secs=>greatest(60,least(p_retry,86400)))
 when p_status in (401,403,404) then now()+interval '10 minutes'
 when (p_status=0 or p_status>=500) and failures>=2 then now()+make_interval(secs=>least(300,30*power(2,least(failures-2,3))::integer))
 else open_until end,
 probe_until=case when p_health then probe_until else null end
 where id=p_provider;
end $$;

create function public.ling_gateway_finish(p_log uuid,p_status text,p_attempts jsonb,p_prompt integer default null,p_completion integer default null) returns void
language plpgsql security invoker set search_path = '' as $$
declare l public.ling_gateway_logs;
begin
 select * into l from public.ling_gateway_logs where id=p_log for update;
 if not found or l.status<>'pending' then return;end if;
 update public.ling_gateway_logs set status=p_status,attempts=p_attempts,prompt_tokens=p_prompt,completion_tokens=p_completion,finished_at=now(),refunded=p_status='failed' where id=p_log;
 if p_status='failed' then update public.ling_gateway_usage set requests=greatest(0,requests-1)
 where user_id=l.user_id and day=(l.started_at at time zone 'Asia/Shanghai')::date;end if;
end $$;

create function public.ling_gateway_login_attempt(p_ip text) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
 insert into public.ling_gateway_login_limits(ip_hash,attempts) values(p_ip,1)
 on conflict(ip_hash) do update set attempts=case when ling_gateway_login_limits.window_start<now()-interval '15 minutes' then 1 else ling_gateway_login_limits.attempts+1 end,
 window_start=case when ling_gateway_login_limits.window_start<now()-interval '15 minutes' then now() else ling_gateway_login_limits.window_start end
 returning attempts into n;
 return n<=10;
end $$;

revoke execute on function public.ling_gateway_reserve(uuid,text),public.ling_gateway_claim(uuid,boolean),public.ling_gateway_provider_result(uuid,integer,integer,boolean,boolean,integer),public.ling_gateway_finish(uuid,text,jsonb,integer,integer),public.ling_gateway_login_attempt(text) from public,anon,authenticated;
grant execute on function public.ling_gateway_reserve(uuid,text),public.ling_gateway_claim(uuid,boolean),public.ling_gateway_provider_result(uuid,integer,integer,boolean,boolean,integer),public.ling_gateway_finish(uuid,text,jsonb,integer,integer),public.ling_gateway_login_attempt(text) to service_role;

insert into public.ling_gateway_users(name,role,daily_limit) values('玲','admin',null);
insert into public.ling_gateway_providers(name,kind,base_url,priority,aliases,daily_limit,rpm_limit) values
('Gemini 官方免费','gemini','https://generativelanguage.googleapis.com/v1beta/openai',10,'{"fast":"gemini-2.5-flash","smart":"gemini-2.5-flash","rp":"gemini-2.5-flash","backup":"gemini-2.5-flash"}',20,5),
('OpenRouter 免费池','openrouter','https://openrouter.ai/api/v1',20,'{"fast":"openrouter/free","smart":"openrouter/free","rp":"openrouter/free","backup":"openrouter/free"}',50,10),
('Cloudflare Workers AI','cloudflare','https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1',30,'{"fast":"@cf/meta/llama-3.1-8b-instruct","smart":"@cf/meta/llama-3.1-8b-instruct","rp":"@cf/meta/llama-3.1-8b-instruct","backup":"@cf/meta/llama-3.1-8b-instruct"}',20,5);

-- A dedicated monitor credential is generated inside Postgres and never returned.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
do $$ declare token text; begin
 token := encode(extensions.gen_random_bytes(32),'hex');
 perform vault.create_secret(token,'ling_gateway_monitor','Only authorizes gateway health checks');
 update public.ling_gateway_settings set monitor_hash=encode(extensions.digest(token,'sha256'),'hex') where id;
end $$;
select cron.schedule('ling-gateway-hourly-health','17 * * * *',
 $job$ select net.http_post(
 url:='https://ibpffxzdjvgydnhmvmvc.supabase.co/functions/v1/ling-ai-gateway/internal/health',
 headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='ling_gateway_monitor')),
 body:='{}'::jsonb,timeout_milliseconds:=30000); $job$);

create function public.ling_gateway_maintenance() returns void language plpgsql security invoker set search_path='' as $$
declare l record; begin
 for l in select id from public.ling_gateway_logs where status='pending' and started_at<now()-interval '5 minutes' loop
 perform public.ling_gateway_finish(l.id,'failed','[]'::jsonb);end loop;
 delete from public.ling_gateway_logs where started_at<now()-interval '30 days';
 delete from public.ling_gateway_usage where day<current_date-90;
 delete from public.ling_gateway_provider_usage where day<current_date-90;
 delete from public.ling_gateway_login_limits where window_start<now()-interval '1 day';
 delete from public.ling_gateway_keys where admin_access and expires_at<now()-interval '1 day';
end $$;
revoke execute on function public.ling_gateway_maintenance() from public,anon,authenticated;
grant execute on function public.ling_gateway_maintenance() to service_role;
select cron.schedule('ling-gateway-maintenance','*/10 * * * *','select public.ling_gateway_maintenance();');
