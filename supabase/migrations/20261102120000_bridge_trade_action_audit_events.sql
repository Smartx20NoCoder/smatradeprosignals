-- Authenticated ScalpEdge/MT5 broker-confirmed management action journal.
-- Unexposed to browser roles; the bridge-report-execution Edge Function
-- (service-role authenticated via INTERNAL_FN_SECRET) writes events here.
CREATE TABLE IF NOT EXISTS public.bridge_trade_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id text NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN (
    'breakeven_lock','early_lock','trailing_sl','rolling_tp',
    'partial_close','risk_block','risk_fill')),
  position_id text,
  signal_id uuid REFERENCES public.signals(id) ON DELETE SET NULL,
  deal_ticket text,
  symbol text,
  stage text,
  old_sl numeric, new_sl numeric, old_tp numeric, new_tp numeric,
  closed_volume numeric, realized_pnl numeric,
  account_equity numeric, account_balance numeric,
  daily_start_equity numeric, daily_drawdown_pct numeric,
  projected_risk_pct numeric, broker_time_epoch bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bridge_trade_events_position_date_idx
  ON public.bridge_trade_events (position_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bridge_trade_events_type_date_idx
  ON public.bridge_trade_events (event_type, created_at DESC);
ALTER TABLE public.bridge_trade_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bridge_trade_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.bridge_trade_events TO service_role;
