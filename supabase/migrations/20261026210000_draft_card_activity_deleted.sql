-- The draft editor card's Discard is recorded too (card-activity.ts): after a
-- Discard in the card the model only met draft_not_found and could not say
-- what had happened to the draft (live test 2026-10-26).
DO $$
BEGIN
  ALTER TABLE public.draft_card_activity DROP CONSTRAINT IF EXISTS draft_card_activity_action_check;
  ALTER TABLE public.draft_card_activity
    ADD CONSTRAINT draft_card_activity_action_check CHECK (action IN ('saved', 'sent', 'deleted'));
END $$;
