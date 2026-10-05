-- Run with Perfetto trace_processor query -f scripts/analyze-android-heap.sql <trace>.
-- Native sizes are sampled live allocations since attachment; Java sizes are
-- allocation churn, because ART allocation profiling does not track frees.
CREATE PERFETTO TABLE whip_profile_target AS
SELECT p.upid, p.pid, p.start_ts, MIN(a.ts) AS first_dump_ts
FROM process p JOIN heap_profile_allocation a USING (upid)
WHERE p.name = 'io.github.kaminarios.whip'
GROUP BY p.upid
ORDER BY p.start_ts DESC, p.upid DESC
LIMIT 1;

SELECT name, idx, value
FROM stats
WHERE value != 0 AND (
  name GLOB 'heapprofd*' OR name GLOB '*buffer*overrun*' OR name GLOB '*data*loss*'
);

CREATE PERFETTO TABLE whip_allocations AS
SELECT a.* FROM heap_profile_allocation a JOIN whip_profile_target USING (upid);

CREATE PERFETTO TABLE whip_allocation_frames AS
WITH RECURSIVE stack AS (
  SELECT DISTINCT callsite_id AS allocation_callsite, callsite_id AS id, 0 AS distance
  FROM whip_allocations
  UNION ALL
  SELECT stack.allocation_callsite, c.parent_id, stack.distance + 1
  FROM stack JOIN stack_profile_callsite c USING (id)
  WHERE c.parent_id IS NOT NULL
), symbols AS (
  SELECT symbol_set_id, MIN(id) AS first_symbol_id
  FROM stack_profile_symbol GROUP BY symbol_set_id
)
SELECT stack.allocation_callsite, stack.distance, m.name AS library, f.rel_pc,
  COALESCE(s.name, f.name) AS function
FROM stack JOIN stack_profile_callsite c USING (id)
JOIN stack_profile_frame f ON f.id = c.frame_id
JOIN stack_profile_mapping m ON m.id = f.mapping
LEFT JOIN symbols ON symbols.symbol_set_id = f.symbol_set_id
LEFT JOIN stack_profile_symbol s ON s.id = symbols.first_symbol_id;

SELECT p.pid, a.heap_name, COUNT(*) AS records,
  ROUND(SUM(CASE WHEN a.size > 0 THEN a.size ELSE 0 END) / 1048576.0, 2) AS allocated_mib,
  ROUND(SUM(a.size) / 1048576.0, 2) AS net_mib
FROM whip_allocations a JOIN process p USING (upid)
GROUP BY a.upid, a.heap_name;

SELECT heap_name, ROUND((ts - first_dump_ts) / 1e9, 2) AS seconds_after_first_dump,
  ROUND(SUM(SUM(size)) OVER (PARTITION BY heap_name ORDER BY ts) / 1048576.0, 2) AS cumulative_mib
FROM whip_allocations JOIN whip_profile_target USING (upid)
GROUP BY heap_name, ts;

CREATE PERFETTO TABLE whip_native_callsites AS
SELECT callsite_id, SUM(size) AS live_bytes,
  SUM(CASE WHEN size > 0 THEN size ELSE 0 END) AS allocated_bytes
FROM whip_allocations
WHERE heap_name = 'libc.malloc'
GROUP BY callsite_id;

-- Attribute each allocation to its nearest frame outside allocator libraries.
CREATE PERFETTO TABLE whip_native_owners AS
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY allocation_callsite ORDER BY distance) AS rank
  FROM whip_allocation_frames
  WHERE library NOT GLOB '*/libc.so'
    AND library NOT GLOB '*libc++*.so'
    AND library NOT GLOB '*libheapprofd*'
)
SELECT allocation_callsite, library, function, rel_pc FROM ranked WHERE rank = 1;

SELECT o.library, ROUND(SUM(n.live_bytes) / 1048576.0, 2) AS live_mib,
  ROUND(SUM(n.allocated_bytes) / 1048576.0, 2) AS allocated_mib
FROM whip_native_callsites n JOIN whip_native_owners o ON o.allocation_callsite = n.callsite_id
GROUP BY o.library ORDER BY SUM(n.live_bytes) DESC;

SELECT o.library, o.function, o.rel_pc,
  ROUND(SUM(n.live_bytes) / 1048576.0, 2) AS live_mib
FROM whip_native_callsites n JOIN whip_native_owners o ON o.allocation_callsite = n.callsite_id
GROUP BY o.library, o.function, o.rel_pc
ORDER BY SUM(n.live_bytes) DESC LIMIT 25;

-- The nearest managed caller explains Java churn better than ART allocator frames.
WITH ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY allocation_callsite ORDER BY distance) AS rank
  FROM whip_allocation_frames
  WHERE function GLOB '*.*' AND library NOT GLOB '*.so'
)
SELECT r.function, r.library AS mapping,
  ROUND(SUM(a.size) / 1048576.0, 2) AS allocated_mib
FROM whip_allocations a JOIN ranked r ON r.allocation_callsite = a.callsite_id
WHERE a.heap_name = 'com.android.art' AND r.rank = 1
GROUP BY r.function, r.library ORDER BY SUM(a.size) DESC LIMIT 25;
