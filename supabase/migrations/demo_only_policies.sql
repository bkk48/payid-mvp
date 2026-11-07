-- DEMO ONLY: lets demo.html (anon key) read intents + get realtime.
-- DROP THIS before going live:
--   drop policy payment_intents_read_anon_demo on public.payment_intents;
create policy payment_intents_read_anon_demo on public.payment_intents
  for select to anon using (true);
