"""Record the configured iPhone simulator. Run with uv run, on mini.

Actions are JSON objects with `at` (seconds) and `command` (AXe arguments).
The action log records actual execution times; encoding/retiming is separate.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import time


DEVICE = "35AF86B7-DC94-48B9-8215-82C9DE8E08F7"
BUNDLE = "io.github.kaminarios.whip"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name")
    parser.add_argument("duration", type=float)
    parser.add_argument("actions", type=Path)
    parser.add_argument("--device", default=DEVICE)
    parser.add_argument("--start-app", default=BUNDLE, help="App to foreground before recording")
    parser.add_argument("--axe", default=os.environ.get("AXE_BIN", "axe"))
    parser.add_argument("--output", type=Path, default=Path("build/launch-refresh/recordings"))
    args = parser.parse_args()
    os.environ.setdefault("AXE_HID_STABILIZATION_MS", "25")
    actions = json.loads(args.actions.read_text())
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output / args.name
    if output.with_suffix(".mov").exists():
        raise FileExistsError(f"Keep the earlier take: {output}.mov already exists")
    simctl = ["xcrun", "simctl"]
    subprocess.run(simctl + ["launch", args.device, args.start_app], check=True)
    log_path = output.with_suffix(".log")
    with log_path.open("w") as log:
        recorder = subprocess.Popen(
            simctl + ["io", args.device, "recordVideo", "--codec=h264", str(output.with_suffix(".mov"))],
            stdout=log, stderr=log,
        )
        actual = []
        try:
            for _ in range(200):
                if "Recording started" in log_path.read_text():
                    break
                if recorder.poll() is not None:
                    raise RuntimeError(log_path.read_text())
                time.sleep(0.1)
            else:
                raise TimeoutError("The simulator recorder did not start")
            start = time.monotonic()
            print(f"Recording {args.name}", flush=True)
            for action in actions:
                time.sleep(max(0, action["at"] - (time.monotonic() - start)))
                stamp = {"at": round(time.monotonic() - start, 3), "command": action["command"]}
                command = action["command"].copy()
                if command[0] == "type":
                    # Xcode 27 can drop rapid keyboard HID events. Keep the
                    # same input session and give each real character time to land.
                    steps = [step for char in command[1] for step in (f"type {shlex.quote(char)}", "sleep 0.1")]
                    command = ["batch", "--type-submission", "composite"]
                    for step in steps:
                        command += ["--step", step]
                if command[0] == "tap":
                    if "--tap-style" not in command:
                        command += ["--tap-style", "physical"]
                    if "--post-delay" not in command:
                        command += ["--post-delay", "0.6"]
                if command[0] == "simctl":
                    subprocess.run(simctl + [command[1], args.device] + command[2:], check=True)
                else:
                    subprocess.run([args.axe] + command + ["--udid", args.device], check=True)
                stamp["finishedAt"] = round(time.monotonic() - start, 3)
                actual.append(stamp)
            time.sleep(max(2, args.duration - (time.monotonic() - start)))
        finally:
            recorder.send_signal(signal.SIGINT)
            recorder.wait(timeout=30)
            output.with_suffix(".actions.json").write_text(json.dumps(actual, indent=2) + "\n")
        if recorder.returncode != 0:
            raise RuntimeError(log_path.read_text())
    print(f"Saved {output}.mov", flush=True)


if __name__ == "__main__":
    main()
