begin;
set local lock_timeout = '3s';
set local statement_timeout = '10s';

alter table public.ling_gateway_settings
  drop constraint ling_gateway_settings_max_output_tokens_check,
  alter column max_output_tokens drop not null,
  alter column max_output_tokens drop default,
  alter column max_output_tokens type bigint using max_output_tokens::bigint,
  add constraint ling_gateway_settings_max_output_tokens_check
    check (max_output_tokens is null or max_output_tokens between 1 and 9007199254740991);

commit;
