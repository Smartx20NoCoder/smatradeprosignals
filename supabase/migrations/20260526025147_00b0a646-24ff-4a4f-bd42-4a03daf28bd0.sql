SELECT cron.unschedule('scalpedge-scan-15m');
SELECT cron.unschedule('scalpedge-news-calendar');

SELECT cron.schedule(
  'scalpedge-scan-15m',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gvxiwqbuurwksvjqsuoy.supabase.co/functions/v1/scan-signals',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eGl3cWJ1dXJ3a3N2anFzdW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDMyNDIsImV4cCI6MjA5NDc3OTI0Mn0.XazR4Te9STYeIYe-9sHbSWnn6jZX229QbIEvm1-9UU4',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eGl3cWJ1dXJ3a3N2anFzdW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDMyNDIsImV4cCI6MjA5NDc3OTI0Mn0.XazR4Te9STYeIYe-9sHbSWnn6jZX229QbIEvm1-9UU4',
      'x-fn-secret', 'chelseafc'
    ),
    body := jsonb_build_object('mode', 'latest', 'source', 'cron')
  );
  $$
);

SELECT cron.schedule(
  'scalpedge-news-calendar',
  '0 1 * * *',
  $$
  SELECT net.http_post(
    url := 'https://gvxiwqbuurwksvjqsuoy.supabase.co/functions/v1/fetch-news-calendar',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd2eGl3cWJ1dXJ3a3N2anFzdW95Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkyMDMyNDIsImV4cCI6MjA5NDc3OTI0Mn0.XazR4Te9STYeIYe-9sHbSWnn6jZX229QbIEvm1-9UU4',
      'x-fn-secret', 'chelseafc'
    ),
    body := jsonb_build_object('source', 'cron')
  ) AS request_id;
  $$
);