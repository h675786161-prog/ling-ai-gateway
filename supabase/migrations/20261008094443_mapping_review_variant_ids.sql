-- Keep the station's special transport variant separate from standard Gemini.
-- This only expands the canonical ID format; private-table permissions stay intact.
begin;
set local lock_timeout='3s';
set local statement_timeout='10s';
alter table public.ling_gateway_models drop constraint ling_gateway_canonical_id_check;
alter table public.ling_gateway_models add constraint ling_gateway_canonical_id_check
 check(canonical_id is null or (length(canonical_id)<=200 and canonical_id ~ '^(?:(?:假流式|抗截断|防截断)-)?[a-z0-9][a-z0-9._-]{0,199}$'));
commit;
