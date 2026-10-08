begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
alter table public.ling_gateway_settings add column first_output_timeout_ms integer not null default 90000
 check(first_output_timeout_ms between 5000 and 120000);
alter table public.ling_gateway_models add column diagnostic jsonb
 check(diagnostic is null or (jsonb_typeof(diagnostic)='object' and octet_length(diagnostic::text)<=4096));
alter table public.ling_gateway_replies add column diagnostic jsonb
 check(diagnostic is null or (jsonb_typeof(diagnostic)='object' and octet_length(diagnostic::text)<=4096));
drop function public.ling_gateway_probe_finish(uuid,text,integer,integer,text,text);
create function public.ling_gateway_probe_finish(p_lease uuid,p_status text,p_http integer,p_latency integer,p_hash text,p_returned text default null,p_diagnostic jsonb default null) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;begin
 if p_status='cancelled' then
  update public.ling_gateway_models set lease_token=null,lease_until=null where lease_token=p_lease;
 else
  update public.ling_gateway_models set status=p_status,http_status=p_http,latency_ms=p_latency,
   first_token_ms=case when p_status='available' then p_latency else first_token_ms end,
   config_hash=p_hash,returned_model=left(p_returned,200),diagnostic=p_diagnostic,checked_at=now(),lease_token=null,lease_until=null where lease_token=p_lease;
 end if;
 get diagnostics n=row_count;return n=1;
end $$;
revoke execute on function public.ling_gateway_probe_finish(uuid,text,integer,integer,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.ling_gateway_probe_finish(uuid,text,integer,integer,text,text,jsonb) to service_role;
commit;
