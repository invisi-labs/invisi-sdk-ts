# @invisi-labs/core

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

## 1.1.0

### Minor Changes

- Wallet capabilities, receiving addresses, note and Credit cryptography, encrypted delivery, and FMD detection.

## 1.0.2

## 1.0.1

### Patch Changes

- Export TREE_DEPTH protocol constant from @invisi-labs/core; @invisi-labs/tree now imports it instead of hardcoding.
