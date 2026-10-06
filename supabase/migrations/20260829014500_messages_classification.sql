create type public.classification_status as enum ('pending', 'reviewed');

alter table public.messages 
  add column classification_status public.classification_status not null default 'pending';

create index messages_classification_status_idx 
  on public.messages (classification_status) 
  where classification_status = 'pending';
