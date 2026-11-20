#!/usr/bin/env python3
"""Verify or synchronize only the tiny reviewed Provenance release manifest."""
import argparse
import ast
import hashlib
import json
from pathlib import Path

PIN = "6107789c5c0d24c4130bff05da6d389336feb5ccb247c4030eae5198ab05d762"
RESOURCE_ROOT = Path(__file__).resolve().parents[1] / "packages/prover/src/resources"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("periphery_root", type=Path, nargs="?")
parser.add_argument("--check-package", type=Path, help="Check the tiny source resource metadata directory")
parser.add_argument("--output", type=Path, default=RESOURCE_ROOT)
args = parser.parse_args()
if (args.periphery_root is None) == (args.check_package is None):
    parser.error("Select a Periphery checkout or --check-package, but not both")
source = args.check_package or args.periphery_root
manifest_path = source / ("provenance-manifest.json" if args.check_package else "circuits/provenance/manifest.json")
manifest_bytes = manifest_path.read_bytes()
if hashlib.sha256(manifest_bytes).hexdigest() != PIN:
    raise SystemExit("Untrusted provenance manifest; review and explicitly update the release pin")
manifest = json.loads(manifest_bytes)
if manifest["family"] != "provenance" or manifest["target"] != "evm" or [entry["capacity"] for entry in manifest["circuits"]] != [10, 20, 40, 80, 120, 160, 190]:
    raise SystemExit("Unsupported provenance release")
text = "/** Exact bytes of the existing trusted Provenance release manifest. */\nexport const PROVENANCE_MANIFEST_TEXT = " + json.dumps(manifest_bytes.decode(), ensure_ascii=False) + ";\n"
if args.check_package:
    actual = (source / "provenance-manifest.ts").read_text()
    literal = actual.split("export const PROVENANCE_MANIFEST_TEXT =", 1)[1].strip().removesuffix(";")
    if ast.literal_eval(literal).encode() != manifest_bytes:
        raise SystemExit("Provenance TypeScript metadata differs from reviewed manifest bytes")
    print("Verified tiny pinned provenance manifest metadata across all seven tiers")
else:
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "provenance-manifest.json").write_bytes(manifest_bytes)
    (args.output / "provenance-manifest.ts").write_text(text)
    print(f"Synchronized tiny reviewed provenance manifest metadata to {args.output}")
