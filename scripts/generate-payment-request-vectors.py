#!/usr/bin/env python3
"""Generate language-neutral Note IPR vectors using Python standard-library encoding.

Receiving material is a fixed public test vector. No SDK codec or private key is used.
"""
import base64
import copy
import json
from pathlib import Path

MATERIAL = {'address': '0irFjZ7r3u8t65TeAvH5uTqUJ3KWvsJ983QVcuv83jfKTUMy5Q36R88cst20rxt85TyTnS2k5WAlHS2t8NjykJCVxrK2zgKZ5S50U5uD0G7SuH8AdxYGj0t64Mkgr8qXc5q7gUFFqF', 'ownerAddress': '0x1a642f0e3c3af545e7acbd38b07251b3990914f1', 'viewingPublicKey': '0331c61e324d97cd92808e8673e20b53c6659e8b22e7055a8eefef052cf3912d2c', 'clueKey': '30c3b2848b0a90a3f94e35e8f43973f5a62224f5eabbb206701b140791c4a409'}
BASE = {"chainId": "97", "protocolAddress": "0x" + "11" * 20, "tokenAddress": "0x" + "22" * 20, "amount": "70"}

def uint(value, size):
    return int(value).to_bytes(size, "big")

def encode(request):
    recipient = request["recipient"]
    kind = {"evm": 1, "invisi": 2, "identity": 3}[recipient["type"]]
    data = bytes([1, kind]) + uint(request["chainId"], 8)
    data += bytes.fromhex(request["protocolAddress"][2:]) + bytes.fromhex(request["tokenAddress"][2:]) + uint(request["amount"], 16)
    if kind == 3:
        return data + bytes.fromhex(recipient["identity"][2:])
    if kind == 1:
        data += bytes.fromhex(recipient["address"][2:]) + bytes([int(recipient.get("envelope", True))])
    else:
        data += bytes.fromhex(MATERIAL["ownerAddress"][2:] + MATERIAL["viewingPublicKey"] + MATERIAL["clueKey"])
    data += bytes([int("nonce" in recipient)])
    if "nonce" in recipient:
        data += uint(recipient["nonce"], 32)
    if kind == 2 or recipient.get("envelope", True):
        payload = bytes.fromhex(request.get("payload", "0x")[2:])
        data += uint(len(payload), 2) + payload
    return data

vectors = []
for name, recipient, payload in [
    ("evm-empty-no-nonce", {"type": "evm", "address": "0x" + "33" * 20, "envelope": False}, None),
    ("evm-empty-zero-nonce", {"type": "evm", "address": "0x" + "33" * 20, "envelope": False, "nonce": "0"}, None),
    ("evm-default-envelope", {"type": "evm", "address": "0x" + "33" * 20}, None),
    ("evm-binary-payload", {"type": "evm", "address": "0x" + "33" * 20, "nonce": "256"}, "0x00ff80"),
    ("invisi-reusable", {"type": "invisi", "address": MATERIAL["address"]}, None),
    ("invisi-fixed-payload", {"type": "invisi", "address": MATERIAL["address"], "nonce": "42"}, "0x00ff80"),
    ("identity", {"type": "identity", "identity": "0x" + "00" * 31 + "01"}, None),
]:
    request = {**copy.deepcopy(BASE), "recipient": recipient}
    if payload is not None:
        request["payload"] = payload
    data = encode(request)
    vectors.append({"name": name, "request": request, "binaryHex": data.hex(), "encoded": "ipr:" + base64.urlsafe_b64encode(data).decode("ascii").rstrip("="), "binaryLength": len(data)})
result = {"format": "invisi-note-payment-request-v1", "receivingMaterial": MATERIAL, "vectors": vectors}
target = Path(__file__).resolve().parents[1] / "packages/sdk/src/payment-request/testdata/requests.json"
target.write_text(json.dumps(result, indent=2) + "\n")
print(f"Generated {len(vectors)} independent IPR vectors")
