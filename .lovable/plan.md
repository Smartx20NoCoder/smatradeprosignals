# Restore ScalpEdge Signal Generation

## Goal
Restore normal signal generation with the smallest safe changes and minimal API-credit usage, while preserving broker-risk and duplicate-signal protections.

## Verified Current State
- The scheduled scanner is running every 5 minutes and completes successfully.
- Fresh candle data is being fetched through Key 3; no key is marked exhausted and recent scans have no backend errors.
- The last saved signal was on August 31; zero signals were saved on September 1–3.
- Current settings allow only XAU/USD, BTC/USD, and GBP/USD; the other 7 configured instruments are disabled before analysis.
- Recent scans report zero qualified candidates, with checks ending as either “no pattern” or another strategy filter.
- The saved bridge claim value is already 45 minutes, but the database column and frontend initial-state defaults remain 20.

## Implementation
1. **Run one controlled diagnostic scan**
   - Use a single full/test scan rather than repeated scans.
   - Capture per-pair strategy reasons and identify whether candle shape, ADX, strategy-specific conditions, or pair configuration accounts for the zero-candidate result.
   - Do not weaken confidence, RR, stop-distance, news, or deduplication gates without evidence from this result.

2. **Restore intended scan coverage**
   - Correct the pair gate so enabled scanning coverage matches the intended active instrument set.
   - Keep deliberately disabled pairs disabled; do not confuse “scan this pair” with “auto-execute this pair.” If the existing `pair_auto_execute` setting is meant only for execution, stop using it to suppress market analysis.
   - Preserve market-hours handling and 24/7 crypto behavior.

3. **Fix only the confirmed blocking strategy condition**
   - Adjust the specific regression revealed by the diagnostic scan.
   - Preserve broker error-130 filtering, news blackout, minimum RR/confidence, active-trade limits, and 90-minute/candle deduplication.
   - Add a concise diagnostic reason where a broad “no pattern” result currently hides the blocking condition, so future outages are visible in Health/Edge without another code audit.

4. **Finish the 45-minute claim-expiry fix**
   - Change the database column default from 20 to 45.
   - Change the frontend initial value from 20 to 45 and keep the loaded database value authoritative.
   - Retain the current valid save range and verify a changed value survives reload.

5. **Deploy only what changed**
   - Redeploy `scan-signals` if scanner logic changes.
   - Redeploy `update-settings` only if its implementation changes; its current 5–1440 validation already accepts 45.
   - Let the frontend update through the normal Lovable/GitHub sync path. Keep GitHub Actions as CI verification only; do not add an unsupported direct-hosting deploy command.

6. **Production verification with a credit cap**
   - Confirm the next scheduled run scans the intended pairs, uses fresh/cache data correctly, and reports meaningful strategy outcomes without errors.
   - Run at most one additional manual scan if scheduled-run evidence is insufficient.
   - Verify generated candidates can be saved and become bridge-claimable; do not create a fake live trade solely to prove signal generation.

## Technical Notes
- Prefer cached candles and one targeted diagnostic invocation to limit TwelveData usage.
- A lack of a market setup can legitimately produce zero signals; success means the engine analyzes the intended universe and exposes exact gate outcomes, not that it fabricates a trade.
- The existing CI workflow already installs, formats-checks, lints, type-checks, and builds on GitHub pushes; Lovable publishing remains managed by the platform.