-- Additive migration for model discovery and real generation probes.
create table public.ling_gateway_models (
 provider_id uuid not null references public.ling_gateway_providers(id) on delete cascade,
 model_id text not null check(length(model_id) between 1 and 200), name text not null,
 listed boolean not null default true, source text not null default 'catalog',
 status text not null default 'unchecked' check(status in ('unchecked','available','timeout','rate_limited','unauthorized','not_found','unsupported','empty','network_error','error','no_credit')),
 http_status integer, latency_ms integer, checked_at timestamptz, config_hash text,
 returned_model text, discovered_at timestamptz not null default now(),
 attempts integer not null default 0, lease_token uuid, lease_until timestamptz,
 primary key(provider_id,model_id)
);
alter table public.ling_gateway_models enable row level security;
revoke all on public.ling_gateway_models from anon,authenticated;
grant all on public.ling_gateway_models to service_role;

create function public.ling_gateway_model_catalog(p_provider uuid,p_models jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.ling_gateway_providers where id=p_provider for update;
 if not found then raise exception 'provider not found';end if;
 if jsonb_typeof(p_models)<>'array' or jsonb_array_length(p_models)>1000 then raise exception 'invalid catalog';end if;
 update public.ling_gateway_models set listed=false where provider_id=p_provider and source='catalog';
 insert into public.ling_gateway_models(provider_id,model_id,name,source,listed)
 select p_provider,m->>'id',left(coalesce(m->>'name',m->>'id'),200),'catalog',true from jsonb_array_elements(p_models) m
 on conflict(provider_id,model_id) do update set name=excluded.name,listed=true,source='catalog',discovered_at=now();
end $$;

create function public.ling_gateway_probe_claim(p_provider uuid,p_model text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare p public.ling_gateway_providers; v public.ling_gateway_models; q public.ling_gateway_provider_usage; d date;m timestamptz; lease uuid;
begin
 select * into p from public.ling_gateway_providers where id=p_provider for update;
 if not found or p.secret_cipher is null then return jsonb_build_object('error','provider_key_required');end if;
 select * into v from public.ling_gateway_models where provider_id=p_provider and model_id=p_model for update;
 if not found then return jsonb_build_object('error','model_not_registered');end if;
 if v.lease_until>now() or (select count(*) from public.ling_gateway_models where provider_id=p_provider and lease_until>now())>=2
 then return jsonb_build_object('error','probe_busy','retry_after',2);end if;
 d:=(now() at time zone 'Asia/Shanghai')::date;m:=date_trunc('minute',now());
 insert into public.ling_gateway_provider_usage(provider_id,day) values(p_provider,d) on conflict do nothing;
 select * into q from public.ling_gateway_provider_usage where provider_id=p_provider and day=d for update;
 if p.daily_limit is not null and q.requests>=p.daily_limit then return jsonb_build_object('error','provider_daily_limit');end if;
 if q.minute=m and q.minute_requests>=p.rpm_limit then return jsonb_build_object('error','provider_minute_limit','retry_after',greatest(1,ceil(extract(epoch from (m+interval '1 minute'-now())))::integer));end if;
 update public.ling_gateway_provider_usage set requests=requests+1,minute=m,
 minute_requests=case when minute=m then minute_requests+1 else 1 end where provider_id=p_provider and day=d;
 lease:=gen_random_uuid();
 update public.ling_gateway_models set lease_token=lease,lease_until=now()+interval '90 seconds',attempts=attempts+1 where provider_id=p_provider and model_id=p_model;
 return jsonb_build_object('lease',lease);
end $$;

create function public.ling_gateway_probe_finish(p_lease uuid,p_status text,p_http integer,p_latency integer,p_hash text,p_returned text default null) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;begin
 if p_status='cancelled' then
 update public.ling_gateway_models set lease_token=null,lease_until=null where lease_token=p_lease;
 else
 update public.ling_gateway_models set status=p_status,http_status=p_http,latency_ms=p_latency,config_hash=p_hash,returned_model=left(p_returned,200),checked_at=now(),lease_token=null,lease_until=null where lease_token=p_lease;
 end if;
 get diagnostics n=row_count;return n=1;
end $$;
revoke execute on function public.ling_gateway_model_catalog(uuid,jsonb),public.ling_gateway_probe_claim(uuid,text),public.ling_gateway_probe_finish(uuid,text,integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.ling_gateway_model_catalog(uuid,jsonb),public.ling_gateway_probe_claim(uuid,text),public.ling_gateway_probe_finish(uuid,text,integer,integer,text,text) to service_role;
