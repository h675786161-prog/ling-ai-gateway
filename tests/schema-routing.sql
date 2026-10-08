begin;
do $$
declare u uuid;p uuid;l uuid;lease uuid:=gen_random_uuid();r jsonb;
begin
 insert into public.ling_gateway_users(name,role) values('__routing_sql_test','admin') returning id into u;
 insert into public.ling_gateway_providers(name,kind,base_url) values('__routing_sql_test','custom','https://example.com/v1') returning id into p;
 perform public.ling_gateway_model_catalog(p,'[{"id":"gemini-test","canonical_id":"gemini-test"}]');
 update public.ling_gateway_models set lease_token=lease,lease_until=now()+interval '1 minute' where provider_id=p;
 if not public.ling_gateway_probe_finish(lease,'available',200,17,'test') then raise exception 'probe lease not settled';end if;
 if not exists(select 1 from public.ling_gateway_models where provider_id=p and first_token_ms=17) then raise exception 'probe did not save first text time';end if;
 r:=public.ling_gateway_reserve_routed(u,'gemini-test','smart');l:=(r->>'id')::uuid;
 if not exists(select 1 from public.ling_gateway_logs where id=l and routing_mode='smart') then raise exception 'routing mode not atomically recorded';end if;
 if (select requests from public.ling_gateway_usage where user_id=u)<>1 then raise exception 'routed reservation double-counted quota';end if;
 perform public.ling_gateway_finish(l,'failed','[]');perform public.ling_gateway_finish(l,'failed','[]');
 if (select requests from public.ling_gateway_usage where user_id=u)<>0 then raise exception 'refund not idempotent';end if;
 begin
  perform public.ling_gateway_reserve_routed(u,'gemini-test','bad');raise exception 'invalid mode accepted';
 exception when raise_exception then if sqlerrm<>'invalid routing mode' then raise;end if;end;
 begin
  update public.ling_gateway_settings set hedge_delay_ms=999;raise exception 'invalid delay accepted';
 exception when check_violation then null;end;
 if has_function_privilege('anon','public.ling_gateway_reserve_routed(uuid,text,text)','EXECUTE') or has_function_privilege('authenticated','public.ling_gateway_reserve_routed(uuid,text,text)','EXECUTE') then raise exception 'client can reserve routed quota';end if;
 if not has_function_privilege('service_role','public.ling_gateway_reserve_routed(uuid,text,text)','EXECUTE') then raise exception 'backend cannot reserve routed quota';end if;
end $$;
rollback;
select 'passed' as routing_schema_invariants;
