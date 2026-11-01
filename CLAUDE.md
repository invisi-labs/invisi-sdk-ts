# Repository guide

This pnpm/Turbo workspace publishes `@invisi-labs/*`. Current Solidity/Noir truth is `../invisi-protocol`; canonical protocol docs are `../protocol-docs/01-protocol` and `02-zk-circuits`. Canonical documentation is not an ABI source.

## Commands

- `pnpm install --frozen-lockfile`
- `pnpm build`: ESM/CJS/declarations in dependency order.
- `pnpm test`: all package tests; tests are not cached.
- `pnpm format`: format handwritten TypeScript and JavaScript sources, tests, examples and scripts.
- `pnpm format:check`: check source formatting without modifying files.
- `pnpm lint`: formatting, English-only repository checks and strict TypeScript checks, including examples.
- `pnpm lint:english`: scan non-ignored project text for Chinese characters.
- `pnpm sync:protocol`: sync generated ABIs and authenticated circuit/key assets from the sibling protocol repository. Sync scripts also accept an unpacked protocol release directory.
- `BB_BINARY_PATH=/absolute/path/to/bb INVISI_TEST_WASM=1 pnpm --filter @invisi-labs/prover test`: real native/WASM interoperability; BB must be6.0.0.

Never publish packages, deploy, or push unless requested. Use normal commits; do not amend existing commits without explicit authorization. Commit messages are English.

Use English throughout the repository: code comments, JSDoc, runtime messages, example walkthroughs, tests, and documentation. Do not add Chinese text to project files.

## Current architecture

Core derives Invisi wallet capabilities from valid EVM account private keys through versioned HKDF-SHA256; the application owns HD/mnemonic derivation. Core provides, checked long/short receiving addresses, private WalletAuthorization, canonical Poseidon2 notes/nullifiers, recipient-role-bound delivery, Credit recovery and optional Decaf377 FMD. Invoice identifiers are business data. The original EVM key authorizes arbitrary spending. Complete funds notes permit unsigned full sweeps to that same EVM owner, with no private outputs, deposits, change or fees. Credit lifecycle remains signed. Never restore noteSecret ownership or accept unrestricted unsigned spends.

Use ethers for generic EVM Provider/Signer, Contract, ABI, EIP712 and transaction waiting. Do not reimplement those capabilities; viem is allowed only as a static standard-ABI import in examples. Invisi.prepareRegistration discovers the provider chain's receiving-key registry from Protocol RPC and prepares external registration/update signing requests; Wallet remains offline. Invisi composes protocol-specific read/verification adapters internally from its provider, rejects constructor signer/fundingSigner defaults, and exposes independent signing requests, without implicit event sources or public tree providers. Ethers owns transaction sending, gas, EVM nonces and receipt waiting. Do not add Operation Submitter/submit()/wait() wrappers. WalletSession.sendTransaction may thinly delegate to an injected ethers Signer and return its original TransactionResponse; its Operation overload exports and tracks the hash. Exported plain calls remain usable directly with ethers. Reconcile protocol state independently. WalletSession applies external WalletUpdateBatch candidates through applyUpdates, authenticating receipts via the configured reader and paths against RPC roots; inject MembershipProvider for operation paths. Explicit capability interfaces remain available for custom services. Protocol builds typed calldata and authorization statements; WalletSession owns business orchestration. Use shield, transact, createCredit, creditDraw, cancelCredit, topUpCredit and the separate receiving-key registry. Every Delivery binds ciphertext and clue. Wallet authorization consumes no EVM nonce; funding, permit and registry nonce domains remain independent. Never reintroduce payOpen/payBlind/withdraw/depositCredit/reclaim calls or obsolete deterministic ordinary change rules.

Four ordinary capacities14/56/112/168; only14 supports recursion and aggregates4/8/12. Seven direct-only Credit routes: create,draw1/12/50/120,cancel,top-up. Credit full public widths46/6C+14/11/50. Receiving-key registration uses EIP-712/ERC-1271 owner signatures without a circuit. Top-up requires existing unexpired Credit, expiry not shortened and increased balance. Credit cancellation remains available after expiry/during the local Protocol pause; Factory circuit pause blocks all business including cancellation. Draw/cancel are public ERC20 payouts to leaf-bound addresses.

Node ships14 authenticated compiled circuits and15 target-specific VKs. Use BB6.0.0 and Noir JS1.0.0-rc.6 for compiler rc.6 artifacts. Direct/recursive targets and public-input widths are authenticated; prove and independently verify actual bytes. Never relabel stale proofs, bypass hashes, or claim mock proofs establish circuit soundness. Browser imports must not require Node fs/process/crypto APIs.

Tree sync consumes canonical insertion events, not higher-level business events. Handle live rollover, duplicates, gaps and reorg errors without partial corrupt state. Event output positions are authoritative.

React/Vue useOperation wraps explicit immutable SDK stages. Chain events deliver notes; business negotiation belongs to the application. Never serialize wallet seeds, spending private keys or shared recovery keys into logs or public requests. Explicit low-level remote proving discloses its sensitive witness and is never a high-level automatic fallback.

## Examples

Examples demonstrate public SDK workflows in English. Keep behavior tests in their owning packages; do not put tests, fixture imports or alternate SDK implementations under examples. Use the seven topics 00-wallet, 01-address-registry, 02-transparent-amount, 03-hidden-amount, 04-credit, 05-wallet-session and 06-disclosure. Show SDK composition and external signing requests directly in flat files. Only category 05 uses WalletStore/WalletSession. Account reading and authenticated funds/credit discovery are the permitted small helpers. Keep editable public connection/token/prover settings in examples/settings.ts, without environment variables or business wrappers. Local account files, private keys, SQLite databases and prover binaries must stay ignored; never copy funded keys into the repository. Explicit account initialization must refuse overwrites. Run build/typecheck and the offline wallet smoke command; never execute on-chain examples without authorization. Examples use ethers for runtime EVM operations and may import viem's standard ERC20 ABI without using its client APIs.

## Generated files and verification

Do not hand-edit ABI/circuit/VK assets. Generate ABI from `contracts/out/<name>.sol/<name>.json`, and import circuit assets only after manifest/dependency/artifact/VK checks. Deployment addresses must come from verified records or caller configuration. ProtocolDeployment is defined and parsed by @invisi-labs/rpc: chainId, protocol and optional registry; both contracts use address, runtimeCodeHash and fromBlock. The SDK and its Protocol class must not maintain deployment profiles or catalogs. Invisi.connect validates one multi-token Protocol; WalletSession owns its shared state and canonical synchronization, and each preparation explicitly chooses tokenAddress. TokenProtocol is a per-operation binding composed through protocol.forToken; never restore token-to-instance discovery. Local profiles use mock verifiers and are reproduced by scripts/deploy-local.mjs on fresh default Anvil chain31337. Both local assets use the same Protocol without token registration. The single deployment catalog belongs to ../invisi-protocol/deployment/deployment.json. Protocol deployment tooling owns it; RPC reads that file. Regenerate its local entry only from that controlled deployment. Applications select a trusted Protocol RPC service or independently pin its deployment.

Use independent protocol fixtures for cryptographic and ABI vectors, real calldata decoding for builders, and genuine current Noir/native/WASM proving where applicable. Keep all pnpm build/test/lint checks green. A successful mock verifier says nothing about cryptographic soundness.

## Source layout

Use four spaces, double quotes and semicolons. The formatter prefers 100 columns, or 140 in examples to keep walkthrough messages on one line; this is not a hard line limit. Keep one operation per statement, separate logical phases with blank lines, and expand nontrivial constructors, control flow and business dispatch. Simple accessors may stay compact. Prefer descriptive local names over compressed aliases in lifecycle code.

Run `pnpm format` after source edits and `pnpm lint` before committing. The root formatter covers handwritten code under packages, examples and scripts. Protocol-generated ABI source, ABI identities, witness layouts, circuit/key resources and shared wire fixture bytes are excluded; update those only through their generators. Formatting and behavior changes belong in separate commits.

Public SDK preparation boundaries (`Invisi.prepare*`, `WalletSession.prepare*`, SDK `AddressRegistry.prepareRegistration`) normalize failures to `InvisiError` with code, operation and original cause. Recipient errors carry address/field and zero-based outputIndex where applicable. EVM_ADDRESS_NOT_REGISTERED applies only to short 0x owners; full 0i addresses need no registration. Do not infer error codes from message text, or silently fall back between chain and protocol-rpc discovery. Lower-level protocol/core APIs keep their own errors.
