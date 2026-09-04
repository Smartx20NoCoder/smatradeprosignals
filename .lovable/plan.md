# Restore empirical-confidence signal flow

## Verified state
- The live minimum confidence is already **35%**, not 70%, so the immediate database relief has already been applied and should be preserved.
- Historical results reproduce the reported empirical ranges: XAU/USD EMA Pullback is about **42% shrunk**, BTC/USD EMA Pullback about **38.5%**, and thin-sample GBP/USD VERITAS about **36%**.
- The settings service rejects values below 50, and both confidence controls in Settings enforce a 50 minimum.
- The scanner also has an earlier hardcoded **55%** confidence rejection before the database-controlled final gate. Leaving it unchanged would keep many empirically scored candidates blocked even after widening the Settings range.

## Changes
1. **Make the database threshold authoritative**
   - Remove the scanner's fixed 55% rejection and let the existing final `metaapi_min_confidence` gate decide whether a candidate is saved, alerted, or executed.
   - Keep all other safeguards unchanged, including R:R, news adjustment, trend/broker-distance checks, deduplication, and execution limits.

2. **Allow empirical thresholds in Settings**
   - Change backend validation for `metaapi_min_confidence` from **50–99** to **5–99**.
   - Change both Settings inputs and their client-side clamps from **50–99** to **5–99**.
   - Preserve the current live value of **35%**; no database migration is required.

3. **Deploy only affected backend logic**
   - Redeploy `scan-signals` and `update-settings` only. The frontend follows the normal automatic preview update.

4. **Low-credit verification**
   - Confirm a value below 50 can be saved and read back without being reset.
   - Run at most one controlled scan (or inspect the next scheduled scan) and verify candidates are judged against 35%, while signals below 35% remain blocked.
   - Confirm the scan completes and report whether a qualifying signal was produced; do not weaken any other trading gate merely to force one.
