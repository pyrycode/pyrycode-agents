#!/usr/bin/env python3
"""Validate what the installed Podman actually generates, without installing it."""
import argparse
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("units", type=Path)
parser.add_argument("--generator", default="/usr/libexec/podman/quadlet")
args = parser.parse_args()
result = subprocess.run([args.generator, "-user", "-dryrun"],
                        env={**os.environ, "QUADLET_UNIT_DIRS": str(args.units.resolve())},
                        text=True, capture_output=True, check=True)
output = result.stdout + result.stderr
for project in ["pyrycode", "pyrycode-desktop"]:
    marker = f"---{project}-dispatcher.service---"
    if marker not in output:
        raise SystemExit(f"FAIL: Podman did not generate {project}'s service")
    service = output.split(marker, 1)[1].split("---", 1)[0]
    commands = [line for line in service.splitlines() if line.startswith("ExecStart=")]
    required = ["run --managed", "PYRY_MANAGER_URL=unix:///run/pyry-fleet/manager.sock",
                f"{project}-manager-token,type=env,target=PYRY_MANAGER_TOKEN",
                "%h/pyrycode-runtime/fleet/socket:/run/pyry-fleet:ro", "--userns keep-id"]
    if len(commands) != 1 or any(part not in commands[0] for part in required):
        raise SystemExit(f"FAIL: {project}'s generated command lacks managed mode, identity, socket or credential")
    if "Wants=pyry-fleet-manager.service" not in service or "After=pyry-fleet-manager.service" not in service:
        raise SystemExit(f"FAIL: {project}'s service does not request the host manager")
    if "Slice=pyrycode-agents.slice" not in service:
        raise SystemExit(f"FAIL: {project}'s shared memory ceiling was lost")
print("PASS: both generated services enforce managed startup and share the private host socket")
