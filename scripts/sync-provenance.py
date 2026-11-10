#!/usr/bin/env python3
"""Synchronize or verify public Source proof assets authenticated by a pinned manifest digest."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

PIN = "6107789c5c0d24c4130bff05da6d389336feb5ccb247c4030eae5198ab05d762"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("protocol_root", type=Path, nargs="?")
parser.add_argument("--check-package", type=Path, help="Verify a provisioned package without copying files")
parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "packages" / "prover" / "provenance")
args = parser.parse_args()
if (args.protocol_root is None) == (args.check_package is None):
    parser.error("Select a protocol checkout or --check-package, but not both")
source = (args.check_package or args.protocol_root).resolve()
manifest_path = source / ("manifest.json" if args.check_package else "circuits/provenance/manifest.json")
manifest_bytes = manifest_path.read_bytes()
if hashlib.sha256(manifest_bytes).hexdigest() != PIN:
    raise SystemExit("Untrusted provenance manifest; review and explicitly update the release pin")
manifest = json.loads(manifest_bytes)
if manifest["family"] != "provenance" or manifest["target"] != "evm" or sorted(entry["capacity"] for entry in manifest["circuits"]) != [10, 20, 40, 80, 120, 160, 190]:
    raise SystemExit("Unsupported provenance release")
payloads = [("manifest.json", manifest_bytes)]
for entry in manifest["circuits"]:
    for key in ("artifact", "vk"):
        relative = Path(entry[key])
        if relative.is_absolute() or ".." in relative.parts or relative.parts[:2] != ("circuits", "provenance"):
            raise SystemExit("Invalid provenance artifact path")
        path = (source / relative).resolve()
        if not path.is_relative_to(source):
            raise SystemExit("Provenance artifact escaped checkout")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != entry[key + "Sha256"]:
            raise SystemExit(f"Provenance {key} integrity mismatch for K{entry['capacity']}")
        payloads.append((str(relative), data))
if args.check_package:
    expected = {relative for relative, _ in payloads}
    actual = {str(path.relative_to(source)) for path in source.rglob("*") if path.is_file()}
    if actual != expected:
        raise SystemExit("Unexpected Provenance package asset inventory")
    print(f"Verified pinned manifest and {len(payloads) - 1} public artifacts/VKs across all seven tiers")
    raise SystemExit(0)
capacities = {"k" + str(entry["capacity"]) for entry in manifest["circuits"]}
asset_root = args.output / "circuits" / "provenance"
if asset_root.exists():
    for directory in asset_root.iterdir():
        if directory.name.startswith("k") and directory.name[1:].isdigit() and directory.name not in capacities:
            if directory.is_symlink():
                directory.unlink()
            elif directory.is_dir():
                shutil.rmtree(directory)
for relative, data in payloads:
    destination = args.output / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
print(f"Authenticated {len(manifest['circuits'])} provenance artifacts/VKs to {args.output}")
