#!/usr/bin/env python3
"""Render opt-in full units: Podman 4.9 ignores Quadlet .container.d drop-ins."""
import argparse
from pathlib import Path


def render(source: str, secret: str) -> str:
    if source.count("Exec=run\n") != 1 or source.count("[Unit]\n") != 1:
        raise ValueError("Unexpected base unit; review before generating managed units")
    source = source.replace("[Unit]\n", "[Unit]\nWants=pyry-fleet-manager.service\nAfter=pyry-fleet-manager.service\n", 1)
    return source.replace("Exec=run\n", (
        "Volume=%h/pyrycode-runtime/fleet/socket:/run/pyry-fleet:ro\n"
        "Environment=PYRY_MANAGER_URL=unix:///run/pyry-fleet/manager.sock\n"
        f"Secret={secret},type=env,target=PYRY_MANAGER_TOKEN\n"
        "Exec=run --managed\n"
    ), 1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New staging directory, never the live unit directory")
    args = parser.parse_args()
    base = Path(__file__).resolve().parent.parent
    units = {f"{project}-dispatcher.container": render(
        (base / f"{project}-dispatcher.container").read_text(), f"{project}-manager-token")
        for project in ["pyrycode", "pyrycode-desktop"]}
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, content in units.items():
        (args.output / name).write_text(content)
    print(f"Rendered {len(units)} managed units in {args.output}. Nothing installed.")
