#!/usr/bin/env bash
set -euo pipefail

duration_seconds="${1:-20}"
output_path="${2:-artifacts/perfetto/whip-$(date +%Y%m%d-%H%M%S).perfetto-trace}"
package_name="io.github.kaminarios.whip"
phase_tracing="${WHIP_PERFETTO_PHASE_TRACING:-1}"
# Longer captures need enough room to retain initial process/thread metadata.
default_buffer_kb=196608
if [[ "$duration_seconds" =~ ^[1-9][0-9]*$ ]] && (( duration_seconds > 45 )); then
  default_buffer_kb=524288
fi
buffer_kb="${WHIP_PERFETTO_BUFFER_KB:-$default_buffer_kb}"

if [[ ! "$duration_seconds" =~ ^[1-9][0-9]*$ ]] || (( duration_seconds > 300 )); then
  echo "Duration must be an integer from 1 to 300 seconds." >&2
  exit 2
fi

if [[ "$phase_tracing" != 0 && "$phase_tracing" != 1 ]]; then
  echo "WHIP_PERFETTO_PHASE_TRACING must be 0 or 1." >&2
  exit 2
fi
if [[ ! "$buffer_kb" =~ ^[1-9][0-9]*$ ]] || (( buffer_kb < 65536 || buffer_kb > 524288 )); then
  echo "WHIP_PERFETTO_BUFFER_KB must be between 65536 and 524288." >&2
  exit 2
fi
app_trace_config=""
if [[ "$phase_tracing" == 1 ]]; then
  app_trace_config="atrace_apps: \"$package_name\""
fi

if ! command -v adb >/dev/null; then
  echo "adb is unavailable; run this script with: nix develop -c $0" >&2
  exit 127
fi

device_count="$(adb devices | awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }')"
if [[ "$device_count" != "1" ]]; then
  echo "Expected exactly one authorized Android device; found $device_count." >&2
  adb devices -l >&2
  exit 1
fi

mkdir -p "$(dirname "$output_path")"
duration_ms="$((duration_seconds * 1000))"
remote_path="/data/misc/perfetto-traces/whip-perfetto-trace"

echo "Recording $duration_seconds seconds. For passive tracing, leave Whip untouched while the terminal produces continuous output."
adb shell perfetto --txt -c - -o "$remote_path" <<EOF
buffers: {
  # Continuous terminal output plus sched/gfx/WebView events can exceed 64 MiB
  # in 30 seconds and silently discard the beginning of the reproduction.
  size_kb: $buffer_kb
  fill_policy: RING_BUFFER
}
duration_ms: $duration_ms
data_sources: {
  config {
    name: "linux.ftrace"
    ftrace_config {
      ftrace_events: "sched/sched_switch"
      ftrace_events: "sched/sched_wakeup"
      ftrace_events: "power/cpu_frequency"
      ftrace_events: "power/cpu_idle"
      atrace_categories: "am"
      atrace_categories: "binder_driver"
      atrace_categories: "dalvik"
      atrace_categories: "gfx"
      atrace_categories: "input"
      atrace_categories: "network"
      atrace_categories: "view"
      atrace_categories: "webview"
      $app_trace_config
      buffer_size_kb: 16384
      drain_period_ms: 250
      compact_sched {
        enabled: true
      }
    }
  }
}
data_sources: {
  config {
    name: "linux.process_stats"
    process_stats_config {
      scan_all_processes_on_start: true
      proc_stats_poll_ms: 1000
    }
  }
}
data_sources: {
  config {
    name: "android.packages_list"
  }
}
data_sources: {
  config {
    name: "android.surfaceflinger.frametimeline"
  }
}
EOF

adb pull "$remote_path" "$output_path"
adb shell rm "$remote_path"
echo "Saved $output_path"
echo "Open it at https://ui.perfetto.dev and search for: Whip terminal inbound or Whip SSH latency"
