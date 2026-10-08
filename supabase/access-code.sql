-- Independent gateway gate. Existing website gates are not modified.
alter table public.ling_gateway_settings
  add column access_code_hash text
  check (access_code_hash is null or access_code_hash ~ '^[0-9a-f]{64}$');
