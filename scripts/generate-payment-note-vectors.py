#!/usr/bin/env python3
"""Independent standard-library IPN wire vectors; public Note openings only."""
import base64
import json
from pathlib import Path

CASES = [{'name': 'zero-nonce', 'chainId': '97', 'amount': '70', 'nonce': '0', 'protocolAddress': '0x1111111111111111111111111111111111111111', 'tokenAddress': '0x2222222222222222222222222222222222222222', 'ownerAddress': '0x3333333333333333333333333333333333333333', 'commitment': '0x0125bee867a9ff7d1b5940431ea8a675fac83b9de48b0aa58ae555af4bf31cb6'}, {'name': 'fixed-nonce', 'chainId': '31337', 'amount': '123456789', 'nonce': '42', 'protocolAddress': '0x1111111111111111111111111111111111111111', 'tokenAddress': '0x2222222222222222222222222222222222222222', 'ownerAddress': '0x3333333333333333333333333333333333333333', 'commitment': '0x21405f690f3b4185fdd16b49e823ab84ad2035a96b6d4e27c92283811091e433'}, {'name': 'maximum-fields', 'chainId': '18446744073709551615', 'amount': '340282366920938463463374607431768211455', 'nonce': '21888242871839275222246405745257275088548364400416034343698204186575808495616', 'protocolAddress': '0x1111111111111111111111111111111111111111', 'tokenAddress': '0x2222222222222222222222222222222222222222', 'ownerAddress': '0x3333333333333333333333333333333333333333', 'commitment': '0x0d786aac217035a324867337278f80ae7de5272719c60beec2aee00e7d4980ef'}]

def encode(value):
    parts = [bytes([1])]
    for key, size in [("chainId", 8), ("protocolAddress", 20), ("tokenAddress", 20), ("amount", 16), ("ownerAddress", 20), ("nonce", 32), ("commitment", 32)]:
        raw = value[key]
        parts.append((int(raw, 16) if raw.startswith("0x") else int(raw)).to_bytes(size, "big"))
    return b"".join(parts)

vectors = []
for original in CASES:
    value = {key: item for key, item in original.items() if key != "name"}
    raw = encode(value)
    text = "ipn:" + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    assert len(raw) == 149 and len(text) == 203
    vectors.append({"name": original["name"], "note": value, "binaryHex": raw.hex(), "encoded": text})
output = Path(__file__).resolve().parents[1] / "packages/sdk/src/payment-note/testdata/notes.json"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(vectors, indent=2) + "\n")
print(f"Generated {len(vectors)} independent IPN vectors")
