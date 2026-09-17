-- Relabel the ChatGPT signups that sourceFromUtm filed as X.
--
-- ChatGPT stamps `utm_source=chatgpt.com` onto every link it surfaces.
-- `sourceFromUtm` matched its needles by bare substring in a fixed order, and
-- `t.co` (entry 9) sits inside "chatgp<t.co>m" while `chatgpt` is only entry
-- 15, so from the 09-15 widening until this fix every ChatGPT signup was
-- written as `x_twitter` and the `chatgpt` bucket held zero rows. The reader
-- side was never wrong: `acquisition_referrer`, which is derived from the real
-- Referer host and not from the utm tag, says `chatgpt` on these rows.
--
-- The predicate is the signature of the bug rather than a list of ids: a row
-- claiming X whose own referrer is not X. Three of the five carry
-- `acquisition_referrer = 'chatgpt'` and are certain. The other two carry
-- `direct`, meaning no Referer header at all, which is what the ChatGPT app's
-- in-app browser sends; they are inferred from the utm tag alone and could in
-- principle have been a hand-tagged Twitter link. The time bound keeps this
-- migration from ever touching a genuine X signup recorded after the fix.
update public.workspaces
set acquisition_source = 'chatgpt',
    acquisition_utm_source = 'chatgpt'
where acquisition_source = 'x_twitter'
  and coalesce(acquisition_referrer, 'direct') <> 'x_twitter'
  and created_at < timestamptz '2026-09-17 14:00:00+00';
