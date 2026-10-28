# @invisi-labs/react

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

- Updated dependencies
    - @invisi-labs/sdk@1.1.1

## 1.1.0

### Minor Changes

- React operation hooks for the current wallet and transaction APIs.

## 1.0.2

### Patch Changes

- Updated dependencies [f510aa0]
    - @invisi-labs/payer@1.0.2

## 1.0.1

### Patch Changes

- @invisi-labs/payer@1.0.1
