
## MetaApi Auto-Execution Integration

Hybrid architecture: server fires orders via REST when qualifying signals are saved (works 24/7), browser opens MetaApi WebSocket when the tab is open to show live connection status and position updates.

### 1. Database (migration)

Extend `app_settings` with MetaApi configuration:
- `metaapi_account_id` text
- `metaapi_region` text default `'new-york'`
- `metaapi_auto_trade` boolean default false
- `metaapi_min_confidence` int default 75
- `metaapi_min_rr` numeric default 2.0
- `metaapi_fixed_lot` numeric default 0.01
- `metaapi_connected_at` timestamptz (last successful broker ping)

Extend `signals` with execution tracking:
- `metaapi_position_id` text
- `metaapi_order_id` text
- `metaapi_execution_status` text (`none` | `pending` | `filled` | `failed` | `closed`)
- `metaapi_execution_error` text
- `metaapi_filled_price` numeric
- `metaapi_pnl` numeric

The MetaApi auth token is sensitive → stored as a Supabase secret `METAAPI_TOKEN`, not in the DB.

### 2. Secret

Add `METAAPI_TOKEN` via the secret tool.

### 3. Edge functions (REST against MetaApi Cloud)

All call `https://mt-client-api-v1.{region}.agiliumtrade.ai` with `auth-token` header.

**`metaapi-execute`** (POST `{ signal_id }`)
- Auth via `x-fn-secret: chelseafc`.
- Loads signal + app_settings; rejects if auto-trade off, account/token missing, or thresholds unmet.
- Computes side (`BUY`/`SELL`), volume = `metaapi_fixed_lot`, symbol from pair (`EURUSD` etc).
- Calls `POST /users/current/accounts/{id}/trade` with `ORDER_TYPE_BUY` or `ORDER_TYPE_SELL`, `stopLoss`, `takeProfit` = tp2, `comment` = signal id.
- Persists `metaapi_position_id`, `metaapi_order_id`, `metaapi_filled_price`, `metaapi_execution_status='filled'`, `executed_at`. On error writes `failed` + error text. Never throws to caller.

**`metaapi-sync`** (POST, no body)
- Auth via `x-fn-secret`.
- Fetches open positions + last 50 history deals from MetaApi.
- For each signal where `metaapi_position_id IS NOT NULL AND status='pending'`:
  - If position no longer open → look up close reason from history deals (SL / TP / manual), update `status` (`tp1`/`tp2`/`loss`/`manual`), `outcome_r`, `closed_at`, `metaapi_pnl`, `metaapi_execution_status='closed'`.
  - Else update `metaapi_pnl` only.
- Returns counts; safe to call frequently.

**`metaapi-ping`** (GET)
- Auth via `x-fn-secret`.
- Calls `GET /users/current/accounts/{id}` to verify token + account. Writes `metaapi_connected_at` on success. Returns `{ ok, account: { state, connectionStatus, balance, equity } }`.

### 4. Hook into signal creation

In `scan-signals/index.ts` after a signal row is inserted and passes filters:
- If `metaapi_auto_trade && confidence >= metaapi_min_confidence && rr >= metaapi_min_rr`, fire-and-forget `fetch(metaapi-execute, { signal_id })` (no await blocking the scan loop, but log result to `scan_runs.errors` on failure).

Same hook is **not** added to manual signal saves unless the user manually flags them; existing manual flows stay click-driven.

### 5. Cron

Add pg_cron schedule: `metaapi-sync` every 1 minute during trading hours (reuses existing cron secret pattern).

### 6. Browser (live status + WS)

Install `metaapi.cloud-sdk` (browser-compatible streaming SDK).

New module `src/lib/metaapi-client.ts`:
- `connectMetaApi({ token, accountId, region })` returns a singleton `MetatraderAccount` + `StreamingConnection`.
- Exposes `subscribe(onUpdate)` that emits `{ connectionStatus, positions[], accountInfo }`.
- Gracefully handles missing token (returns null) and reconnects on disconnect.

The token is fetched from a new tiny edge function `get-metaapi-token` (auth via `x-fn-secret: chelseafc`) so it isn't committed in code. The browser caches it in memory only (never localStorage).

### 7. Settings UI (in `src/routes/index.tsx`)

New "MetaApi Auto-Trading" panel near the existing TwelveData key panel:
- Account ID input
- Region select (new-york / london / singapore)
- Token input (write-only, "Save" button calls `update-metaapi-token` edge fn which sets the secret via Supabase admin API — actually we'll store as plain row in a new privileged table because the secrets API isn't writable from edge functions; instead the user sets `METAAPI_TOKEN` once via the Lovable secret prompt and the input is read-only "Configured ✓"). **Decision: token is set once via `add_secret` tool prompt; UI shows status only.**
- Auto-trade toggle
- Min confidence (slider 50–95)
- Min RR (slider 1.0–5.0)
- Fixed lot (number, 0.01–10, step 0.01)
- Connection badge (green "Connected to {broker}" / amber "Demo • Connected" / red "Disconnected"): driven by browser WS subscription.
- "Test connection" button → calls `metaapi-ping`.

### 8. Signal cards

Show execution badge when `metaapi_position_id` exists:
- `EXECUTED @ {filled_price}` with live PnL pill from WS.
- `FAILED` (with tooltip showing `metaapi_execution_error`) when status = failed.

### 9. Demo-first safety

- All flows work identically for demo and live accounts (MetaApi handles this server-side based on the broker account).
- Add a visible "DEMO MODE" indicator in the panel header pulled from the account state returned by `metaapi-ping`.
- Auto-trade defaults to **off** even after configuring credentials.

### Technical notes
- MetaApi REST trade endpoint: `POST /users/current/accounts/{accountId}/trade` with payload `{ actionType: 'ORDER_TYPE_BUY', symbol, volume, stopLoss, takeProfit, comment, clientId }`.
- Region routing: base URL must match the region the account was provisioned in.
- WebSocket SDK runs only in the browser (Cloudflare Workers can't hold persistent WS to MetaApi).
- All edge functions reuse the `chelseafc` shared secret pattern already used by `update-settings`.

### Files touched
- new migration (app_settings + signals columns)
- new `supabase/functions/metaapi-execute/index.ts`
- new `supabase/functions/metaapi-sync/index.ts`
- new `supabase/functions/metaapi-ping/index.ts`
- new `supabase/functions/get-metaapi-token/index.ts`
- edit `supabase/functions/scan-signals/index.ts` (post-insert trigger)
- new `src/lib/metaapi-client.ts`
- edit `src/routes/index.tsx` (settings panel, signal card badge, connection status)
- add secret `METAAPI_TOKEN`
- add pg_cron entry for `metaapi-sync`

Confirm and I'll build it.
