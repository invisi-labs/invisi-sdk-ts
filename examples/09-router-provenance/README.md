# Router output recognition and later private spending

Source identifies public principal from canonical protocol operations, actual funding paths and available call traces. A Router or gas sponsor's outer `tx.from` does not establish the principal's source. These examples use the existing SDK recognition and Provenance APIs; they add no Core/Router arguments and leave the Provenance circuit's 11 public inputs unchanged.

| Scenario | Recognition evidence | Later private Note spending |
| --- | --- | --- |
| Self native -> Router -> Note | Actual native principal, wrapping/swap and final Core funding path | Recognized Note input plus real Provenance proof |
| Self ERC20 -> Router -> Note | Actual ERC20 payer/transfers; allowance alone is not funding | Same |
| Relayed ERC20 -> Router -> Note | Signed payer intent and actual principal transfer; gas relayer is a separate role | Same |
| EIP-7702 -> Router -> Note | Delegated account execution, outer sender and principal owner checked separately | Same |
| Third-party Router -> Note | Verifiable funding flow; pre-registration is not inherently required, and arbitrary calls are not guaranteed recognizable | Same |
| Native -> target token -> Note | Native source path ends in Notes bound to the target token, not native-token Notes | Proof uses that target token's scope |
| Private inputs plus new public funding | New principal follows public recognition; it cannot establish the old private inputs' membership | Prove every private Note input for the actual operation |

Pure public-principal canonical Router `transact` needs the real Core proof to create hidden-amount outputs. There are no old private inputs requiring a Provenance input proof. `shield` is a separate interface with different Core proof requirements. Core validity and source membership are separate proofs.

```sh
pnpm --filter @invisi-examples/scenarios example:router-provenance:recognition --execute
pnpm --filter @invisi-examples/scenarios example:router-provenance:spend --execute
```

Both scripts exit without `--execute` before account/environment/prover/network access. Use the [common SDK setup](../README.md#setup). Source queries use `officialProvenanceClient(protocol.context)`, which authenticates the official service bootstrap and its scope, provider, signing keys and manifest. Proving uses `new Provenance({ prover })` with the SDK default client. No separate endpoint or manual trust pins are needed; trust validation remains inside the SDK.

`01-output-recognition.ts` is read-only. Fill in an actual confirmed Router transaction hash and a Note commitment from it. It queries `getTransactionRecognition()` and `getNoteRecognition()` and prints their actual states/reasons. A successful receipt alone does not imply `recognized`: indexing, confirmation, missing traces and dependencies can leave recognition pending. Querying a public commitment discloses interest in it; no opening, viewing key or witness is sent.

`02-private-note-spend.ts` executes a later ordinary single `transact`, independently of which Router created the input. Configure `app-decryptor.ts` with your App's authenticated decryption callbacks, public account profiles, external `ALICE_PRIVATE_KEY` and a real local Barretenberg 6.0.0 prover. The SDK verifies the authenticated Source manifest against the NativeProver's resource identity. The existing candidate discovery paginates public history, authenticates App-returned plaintext, rejects conflicting indexed rows, independently checks finalized canonical receipt evidence and excludes spent Notes. The scan ends at the lesser of the Protocol RPC indexed head and the independently read canonical finalized height, so newer unfinalized Notes do not interrupt discovery of older recognized Notes. Finalized receipt verification remains required for every candidate. No fixed historical transaction, preselected denomination or private-key reconstruction is used.

It filters candidates by actual recognized status, randomly selects a Note worth at least two base units, pays half to Bob and lets the normal SDK create Alice's change. Preparation independently checks current membership/spent state. It obtains Alice's wallet authorization, creates the Core proof, then calls `Provenance.prove(proved)`. The prover independently verifies recognition evidence and canonical anchors; a query reporting recognized does not bypass proof verification. Openings, viewing keys, amount/nonce witnesses and membership paths stay local.

The public packet is bound to the exact main calldata. The script calls `evaluateTransaction()`, validates operation tracking, calls `Provenance.submit()` (the Source `submitSourceProof(data, sidecars)` path), and broadcasts the main transaction only after acceptance. It simulates the actual main call before sending. Main confirmation and source recognition remain asynchronous; the final `getTracking()` prints the actual state. Source unavailability or invalid evidence stops execution rather than fabricating proof material or downgrading checks. Use the existing [persistent recovery example](../07-broadcaster/03-recover-and-submit-provenance.ts) for an application that must retain encrypted operation state across failures.

`operationIndex` locates a protocol operation within a transaction; it is not an input, output, token or log index. Example02 executes exactly one direct Core `transact`, so its SDK packet uses operation index `0`. For nested or multi-operation Router transactions, use the service's reliable operation locator and the deployment's supported binding API. Do not copy `0` to every operation or infer it from a Router array position. Example02 does not claim multi-operation Router post-hoc proof support.
