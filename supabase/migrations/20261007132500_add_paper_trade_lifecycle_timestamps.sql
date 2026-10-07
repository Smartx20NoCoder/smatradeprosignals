ALTER TABLE public.signals
  ADD COLUMN IF NOT EXISTS paper_triggered_at timestamptz,
  ADD COLUMN IF NOT EXISTS paper_closed_at timestamptz;

UPDATE public.signals
SET
  paper_triggered_at = CASE
    WHEN paper_status IN ('triggered','tp1_hit','tp2_hit','sl_hit','ambiguous','session_closed')
      THEN COALESCE(paper_triggered_at, paper_hit::timestamptz)
    ELSE paper_triggered_at
  END,
  paper_closed_at = CASE
    WHEN paper_status IN ('tp2_hit','sl_hit','ambiguous','session_closed','expired')
      THEN COALESCE(paper_closed_at, paper_hit::timestamptz)
    ELSE paper_closed_at
  END
WHERE paper_hit IS NOT NULL;
