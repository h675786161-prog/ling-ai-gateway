alter table public.ling_gateway_settings
 add column routing_mode text not null default 'smart' check(routing_mode in ('smart','parallel','sequential')),
 add column hedge_delay_ms integer not null default 4000 check(hedge_delay_ms between 1000 and 30000),
 add column multi_reply_limit integer not null default 3 check(multi_reply_limit=0 or multi_reply_limit between 2 and 20);
alter table public.ling_gateway_models add column first_token_ms integer check(first_token_ms>=0);
alter table public.ling_gateway_replies add column first_token_ms integer check(first_token_ms>=0);
alter table public.ling_gateway_logs add column routing_mode text not null default 'legacy' check(routing_mode in ('smart','parallel','sequential','legacy'));
update public.ling_gateway_logs set routing_mode='parallel' where model not in ('fast','smart','rp','backup');
create function public.ling_gateway_reserve_routed(p_user uuid,p_model text,p_mode text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare r jsonb;
begin
 if p_mode is null or p_mode not in ('smart','parallel','sequential') then raise exception 'invalid routing mode';end if;
 r:=public.ling_gateway_reserve(p_user,p_model);
 if r ? 'id' then update public.ling_gateway_logs set routing_mode=p_mode where id=(r->>'id')::uuid;end if;
 return r;
end $$;
revoke execute on function public.ling_gateway_reserve_routed(uuid,text,text) from public,anon,authenticated;
grant execute on function public.ling_gateway_reserve_routed(uuid,text,text) to service_role;
create or replace function public.ling_gateway_probe_finish(p_lease uuid,p_status text,p_http integer,p_latency integer,p_hash text,p_returned text default null) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;begin
 if p_status='cancelled' then
  update public.ling_gateway_models set lease_token=null,lease_until=null where lease_token=p_lease;
 else
  update public.ling_gateway_models set status=p_status,http_status=p_http,latency_ms=p_latency,
   first_token_ms=case when p_status='available' then p_latency else first_token_ms end,
   config_hash=p_hash,returned_model=left(p_returned,200),checked_at=now(),lease_token=null,lease_until=null where lease_token=p_lease;
 end if;
 get diagnostics n=row_count;return n=1;
end $$;
