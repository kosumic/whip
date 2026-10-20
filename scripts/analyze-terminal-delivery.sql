-- Run with benchmark-terminal-bridge.ts --trace TRACE --trace-processor BINARY.
-- Existing spans deliberately retain their historical acknowledgement semantics.
-- The publisher also probes an empty/full mailbox. Only preparations followed
-- by a callback on that worker performed serialization of a delivered batch.
WITH delivery_calls AS (
  SELECT id, name, LEAD(name) OVER (PARTITION BY track_id ORDER BY ts, id) AS next_name
  FROM slice WHERE name IN ('Whip terminal Rust batch serialization', 'Whip terminal inbound native to JS', 'Whip terminal native dispatch')
)
SELECT name, COUNT(*) AS samples,
  ROUND(PERCENTILE(dur, 50) / 1e6, 3) AS median_ms,
  ROUND(PERCENTILE(dur, 95) / 1e6, 3) AS p95_ms
FROM slice WHERE name GLOB 'Whip terminal *' AND dur > 0 AND dur < 9e9
AND (name != 'Whip terminal Rust batch serialization' OR id IN (
  SELECT id FROM delivery_calls WHERE name = 'Whip terminal Rust batch serialization'
    AND next_name IN ('Whip terminal inbound native to JS', 'Whip terminal native dispatch')
))
GROUP BY name ORDER BY median_ms DESC;

-- Native callback entry to its JS execution, across threads. Include only
-- windows containing exactly one matching execution; simultaneous terminal
-- callbacks cannot be correlated unambiguously by the historical markers.
WITH callback_queue AS (
  SELECT outer_call.id, MIN(js_call.ts) - outer_call.ts AS queue_ns,
    COUNT(*) AS matches
  FROM slice outer_call JOIN slice js_call
    ON js_call.ts >= outer_call.ts
    AND js_call.ts + js_call.dur <= outer_call.ts + outer_call.dur
  WHERE outer_call.name = 'Whip terminal inbound native to JS'
    AND js_call.name = 'Whip terminal inbound JS callback execution'
    AND outer_call.dur > 0 AND js_call.dur > 0
  GROUP BY outer_call.id
)
SELECT COUNT(*) AS unambiguous_callbacks,
  ROUND(PERCENTILE(queue_ns, 50) / 1e6, 3) AS js_queue_median_ms,
  ROUND(PERCENTILE(queue_ns, 95) / 1e6, 3) AS js_queue_p95_ms
FROM callback_queue WHERE matches = 1;

-- These durations are measured inside WebView; callback queue delay is separate.
SELECT t.name, COUNT(*) AS samples,
  ROUND(PERCENTILE(c.value, 50) / 1000, 3) AS median_ms,
  ROUND(PERCENTILE(c.value, 95) / 1000, 3) AS p95_ms
FROM counter c JOIN counter_track t ON c.track_id = t.id
WHERE t.name GLOB 'Whip terminal WebView * us' OR t.name GLOB 'Whip terminal native WebView * us'
GROUP BY t.name ORDER BY t.name;

SELECT COUNT(*) AS payload_samples, ROUND(SUM(c.value) / 1048576.0, 3) AS observed_payload_mib,
  ROUND(SUM(c.value) / 1048576.0 / ((SELECT end_ts - start_ts FROM trace_bounds) / 1e9), 3) AS observed_payload_mib_per_second
FROM counter c JOIN counter_track t ON c.track_id = t.id
WHERE t.name IN ('Whip terminal inbound frame bytes', 'Whip terminal native frame bytes');

-- CPU uses scheduler running time, not wall duration of blocking callbacks.
-- 100% is one fully occupied CPU core. Separate WebView/GPU processes are not
-- attributed to Whip here because their parent is the system WebView zygote.
SELECT th.name AS thread, ROUND(SUM(s.dur) / 1e6, 3) AS cpu_ms,
  ROUND(100.0 * SUM(s.dur) / (SELECT end_ts - start_ts FROM trace_bounds), 2) AS cpu_percent
FROM sched s JOIN thread th USING (utid) JOIN process p USING (upid)
WHERE p.name = 'io.github.kaminarios.whip' AND s.dur > 0
GROUP BY th.utid ORDER BY cpu_ms DESC;

SELECT ROUND(SUM(s.dur) / 1e6, 3) AS app_process_cpu_ms,
  ROUND(100.0 * SUM(s.dur) / (SELECT end_ts - start_ts FROM trace_bounds), 2) AS app_process_cpu_percent
FROM sched s JOIN thread th USING (utid) JOIN process p USING (upid)
WHERE p.name = 'io.github.kaminarios.whip' AND s.dur > 0;

SELECT t.name, ROUND(MAX(c.value) / 1048576.0, 2) AS peak_mib,
  ROUND(AVG(CASE WHEN c.ts > (SELECT start_ts + (end_ts - start_ts) * 2 / 3 FROM trace_bounds)
    THEN c.value END) / 1048576.0, 2) AS final_third_mean_mib
FROM counter c JOIN process_counter_track t ON c.track_id = t.id JOIN process p USING (upid)
WHERE p.name = 'io.github.kaminarios.whip' AND t.name IN ('mem.rss', 'mem.rss.anon', 'mem.swap')
GROUP BY t.name;
