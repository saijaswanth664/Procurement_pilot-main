drop policy profiles_update_own on public.profiles;
drop policy profiles_update_owner on public.profiles;

create policy profiles_update
  on public.profiles for update to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_business_owner())
  )
  with check (
    (
      id = (select auth.uid())
      and role = (select private.current_app_role())
    )
    or (select private.is_business_owner())
  );
