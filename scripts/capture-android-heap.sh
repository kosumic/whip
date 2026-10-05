#!/usr/bin/env bash
set -euo pipefail

duration_seconds="${1:-60}"
output_path="${2:-artifacts/memory/whip-heap-$(date +%Y%m%d-%H%M%S).perfetto-trace}"
package_name='io.github.kaminarios.whip'
heap_kind="${3:-native}"
case "$heap_kind" in
  native) heap_name='libc.malloc'; sampling_interval_bytes=32768 ;;
  java) heap_name='com.android.art'; sampling_interval_bytes=131072 ;;
  *) echo 'Heap kind must be native or java.' >&2; exit 2 ;;
esac

if [[ ! "$duration_seconds" =~ ^[1-9][0-9]*$ ]] || (( duration_seconds > 300 )); then
  echo 'Duration must be an integer from 1 to 300 seconds.' >&2
  exit 2
fi
if ! command -v adb >/dev/null; then
  echo "Run with: nix develop -c bash $0 [seconds] [output] [native|java]" >&2
  exit 127
fi
mapfile -t devices < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
serial="${ANDROID_SERIAL:-}"
if [[ -z "$serial" && ${#devices[@]} == 1 ]]; then
  serial="${devices[0]}"
fi
if [[ -z "$serial" ]] || ! printf '%s\n' "${devices[@]}" | rg -Fxq -- "$serial"; then
  echo 'Select one authorized device with ANDROID_SERIAL, or connect exactly one device.' >&2
  exit 1
fi
device_adb() { adb -s "$serial" "$@"; }
if ! device_adb shell pm path "$package_name" | rg -q '^package:'; then
  echo "Whip is not installed on $serial." >&2
  exit 1
fi
if [[ -e "$output_path" || -e "$output_path.pbtxt" ]]; then
  echo "Refusing to overwrite an earlier capture: $output_path" >&2
  exit 1
fi
mkdir -p "$(dirname "$output_path")"
remote_path="/data/misc/perfetto-traces/whip-heap-$(date +%Y%m%d-%H%M%S)-$$"

cat > "$output_path.pbtxt" <<EOF
buffers { size_kb: 65536 fill_policy: RING_BUFFER }
duration_ms: $((duration_seconds * 1000))
data_sources {
  config {
    name: "android.heapprofd"
    heapprofd_config {
      process_cmdline: "$package_name"
      sampling_interval_bytes: $sampling_interval_bytes
      heaps: "$heap_name"
      shmem_size_bytes: 67108864
      adaptive_sampling_shmem_threshold: 8388608
      adaptive_sampling_max_sampling_interval_bytes: 524288
      max_heapprofd_memory_kb: 524288
      continuous_dump_config { dump_interval_ms: 5000 }
    }
  }
}
data_sources {
  config {
    name: "linux.process_stats"
    process_stats_config {
      scan_all_processes_on_start: true
      proc_stats_poll_ms: 1000
    }
  }
}
data_sources { config { name: "android.packages_list" } }
EOF

echo "Recording $duration_seconds seconds of $heap_kind allocation activity."
echo 'Requires an upload-signed release built with -Pwhip.profileable=true.'
echo 'Switch chats normally. For startup allocations, launch Whip after recording starts.'
device_adb shell perfetto --txt -c - -o "$remote_path" < "$output_path.pbtxt"
device_adb pull "$remote_path" "$output_path"
device_adb shell rm "$remote_path"
echo "Saved $output_path; open locally in https://ui.perfetto.dev."
