-- Run after model-fanout.sql. All fixtures and mutations are rolled back.
begin;
do $$
declare u uuid;p uuid;l uuid;l2 uuid;r jsonb;
begin
 insert into public.ling_gateway_users(name,role) values('__fanout_sql_test','admin') returning id into u;
 insert into public.ling_gateway_providers(name,kind,base_url,enabled) values('__fanout_sql_test','custom','https://example.com/v1',true) returning id into p;
 perform public.ling_gateway_model_catalog(p,'[{"id":"station/gemini-test","canonical_id":"gemini-test"}]');
 update public.ling_gateway_models set canonical_id='gemini-manual',canonical_source='manual' where provider_id=p;
 perform public.ling_gateway_model_catalog(p,'[{"id":"station/gemini-test","canonical_id":"gemini-test"}]');
 if not exists(select 1 from public.ling_gateway_models where provider_id=p and canonical_id='gemini-manual') then raise exception 'catalog overwrote manual mapping';end if;
 update public.ling_gateway_models set canonical_id=null where provider_id=p;
 perform public.ling_gateway_model_catalog(p,'[{"id":"station/gemini-test","canonical_id":"gemini-test"}]');
 if exists(select 1 from public.ling_gateway_models where provider_id=p and canonical_id is not null) then raise exception 'catalog restored manually hidden model';end if;
 perform public.ling_gateway_route_result(p,404,25,false);
 if exists(select 1 from public.ling_gateway_providers where id=p and (open_until is not null or failures<>0 or last_status<>404 or total_errors<>1)) then raise exception 'model 404 opened station circuit';end if;
 perform public.ling_gateway_route_result(p,429,30,false,120);
 if not exists(select 1 from public.ling_gateway_providers where id=p and open_until>now()+interval '119 seconds') then raise exception '429 circuit ignored retry-after';end if;
 perform public.ling_gateway_route_result(p,200,15,true);
 if exists(select 1 from public.ling_gateway_providers where id=p and (open_until is not null or failures<>0)) then raise exception 'successful recovery did not clear circuit';end if;
 r:=public.ling_gateway_reserve(u,'gemini-test');l:=(r->>'id')::uuid;
 r:=public.ling_gateway_reserve(u,'gemini-test');l2:=(r->>'id')::uuid;
 insert into public.ling_gateway_replies(log_id,provider_id,provider_name,upstream_model,choice_index,status,message) values(l,p,'test','gemini-test',0,'partial','{"role":"assistant","content":"preserved"}');
 update public.ling_gateway_logs set started_at=now()-interval '6 minutes' where id in(l,l2);
 perform public.ling_gateway_maintenance();
 if not exists(select 1 from public.ling_gateway_logs where id=l and status='partial' and not refunded) then raise exception 'maintenance discarded saved partial reply';end if;
 if not exists(select 1 from public.ling_gateway_logs where id=l2 and status='failed' and refunded) then raise exception 'maintenance did not refund empty failure';end if;
 if (select requests from public.ling_gateway_usage where user_id=u)<>1 then raise exception 'logical quota not settled once';end if;
 delete from public.ling_gateway_logs where id=l;
 if exists(select 1 from public.ling_gateway_replies where log_id=l) then raise exception 'reply retention did not cascade';end if;
 if not (select relrowsecurity from pg_class where oid='public.ling_gateway_replies'::regclass) then raise exception 'replies RLS disabled';end if;
 if has_table_privilege('anon','public.ling_gateway_replies','SELECT') or has_table_privilege('authenticated','public.ling_gateway_replies','SELECT') then raise exception 'client role can read replies';end if;
 if has_function_privilege('anon','public.ling_gateway_route_result(uuid,integer,integer,boolean,integer)','EXECUTE') or has_function_privilege('authenticated','public.ling_gateway_model_catalog(uuid,jsonb)','EXECUTE') then raise exception 'client role can execute private RPC';end if;
 if not has_table_privilege('service_role','public.ling_gateway_replies','SELECT,INSERT,UPDATE,DELETE') or not has_function_privilege('service_role','public.ling_gateway_route_result(uuid,integer,integer,boolean,integer)','EXECUTE') then raise exception 'backend permissions missing';end if;
end $$;
rollback;
select 'passed' as fanout_schema_invariants;
