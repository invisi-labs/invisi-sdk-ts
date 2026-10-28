# @invisi-labs/protocol

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

- Updated dependencies
    - @invisi-labs/core@1.1.1
    - @invisi-labs/prover@1.1.1
    - @invisi-labs/rpc@1.1.1

## 1.1.0

### Minor Changes

- Current multi-token Protocol and registry interfaces, transaction preparation, authorization statements, and authenticated witness layouts.
