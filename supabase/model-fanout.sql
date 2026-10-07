alter table public.ling_gateway_models add column canonical_id text,
 add column canonical_source text not null default 'auto' check(canonical_source in ('auto','manual'));
alter table public.ling_gateway_models add constraint ling_gateway_canonical_id_check check(canonical_id is null or canonical_id ~ '^[a-z0-9][a-z0-9._-]{0,199}$');
create index ling_gateway_models_canonical on public.ling_gateway_models(canonical_id,provider_id) where listed and canonical_id is not null;
-- Backfill only recognizable IDs. Unclear station-specific names require an explicit mapping.
update public.ling_gateway_models m set canonical_id=lower(regexp_replace(regexp_replace(m.model_id,'^.*\/',''),':free$',''))
where lower(regexp_replace(regexp_replace(m.model_id,'^.*\/',''),':free$','')) ~ '^(gemini-|claude-|gpt-|chatgpt-|o[134](-|$)|deepseek-|llama-|qwen|qwq-|qvq-|glm-|kimi-|moonshot-|mistral-|mixtral-|codestral-|ministral-|pixtral-|magistral-|gemma-|command-|grok-|ernie-|yi-|nemotron-|jamba-|granite-|olmo-|phi-|nova-|hermes-|minimax-|longcat-|devstral-)[a-z0-9._-]*$';
create or replace function public.ling_gateway_model_catalog(p_provider uuid,p_models jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform 1 from public.ling_gateway_providers where id=p_provider for update;
 if not found then raise exception 'provider not found';end if;
 if jsonb_typeof(p_models)<>'array' or jsonb_array_length(p_models)>1000 then raise exception 'invalid catalog';end if;
 update public.ling_gateway_models set listed=false where provider_id=p_provider and source='catalog';
 insert into public.ling_gateway_models(provider_id,model_id,name,source,listed,canonical_id)
 select p_provider,m->>'id',left(coalesce(m->>'name',m->>'id'),200),'catalog',true,m->>'canonical_id' from jsonb_array_elements(p_models) m
 on conflict(provider_id,model_id) do update set name=excluded.name,listed=true,source='catalog',discovered_at=now(),
 canonical_id=case when ling_gateway_models.canonical_source='manual' then ling_gateway_models.canonical_id else coalesce(excluded.canonical_id,ling_gateway_models.canonical_id) end;
end $$;
create table public.ling_gateway_replies (
 log_id uuid not null references public.ling_gateway_logs(id) on delete cascade,
 provider_id uuid not null, provider_name text not null, upstream_model text not null, returned_model text,
 choice_index integer, status text not null check(status in ('success','partial','failed','skipped')),
 http_status integer not null default 0, latency_ms integer not null default 0,
 message jsonb not null default '{}', finish_reason text, usage jsonb, reason text,
 created_at timestamptz not null default now(), primary key(log_id,provider_id)
);
alter table public.ling_gateway_replies enable row level security;
revoke all on public.ling_gateway_replies from public,anon,authenticated;
grant select,insert,update,delete on public.ling_gateway_replies to service_role;
-- Missing/forbidden individual models must not shut down other models of the same station.
create function public.ling_gateway_route_result(p_provider uuid,p_status integer,p_latency integer,p_success boolean,p_retry integer default 0) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform public.ling_gateway_provider_result(p_provider,case when p_status in (403,404) then 400 else p_status end,p_latency,p_success,false,p_retry);
 if p_status in (403,404) then update public.ling_gateway_providers set last_status=p_status where id=p_provider;end if;
end $$;
revoke execute on function public.ling_gateway_model_catalog(uuid,jsonb),public.ling_gateway_route_result(uuid,integer,integer,boolean,integer) from public,anon,authenticated;
grant execute on function public.ling_gateway_model_catalog(uuid,jsonb),public.ling_gateway_route_result(uuid,integer,integer,boolean,integer) to service_role;
create or replace function public.ling_gateway_maintenance() returns void language plpgsql security invoker set search_path='' as $$
declare l record;v_status text;v_attempts jsonb;begin
 for l in select id from public.ling_gateway_logs where status='pending' and started_at<now()-interval '5 minutes' loop
  select case when count(*) filter(where status in ('success','partial'))>0 then 'partial' else 'failed' end,
   coalesce(jsonb_agg(jsonb_build_object('provider_id',provider_id,'status',http_status,'latency_ms',latency_ms,'outcome',status)),'[]'::jsonb)
   into v_status,v_attempts from public.ling_gateway_replies where log_id=l.id;
  perform public.ling_gateway_finish(l.id,v_status,v_attempts);
 end loop;
 delete from public.ling_gateway_logs where started_at<now()-interval '30 days';
 delete from public.ling_gateway_usage where day<current_date-90;
 delete from public.ling_gateway_provider_usage where day<current_date-90;
 delete from public.ling_gateway_login_limits where window_start<now()-interval '1 day';
 delete from public.ling_gateway_keys where admin_access and expires_at<now()-interval '1 day';
end $$;
