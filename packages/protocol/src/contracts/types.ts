import type { invisiCoreAbi } from "./abis/InvisiCore";
import type { invisiCoreFactoryAbi } from "./abis/InvisiCoreFactory";
import type { verifierRouterAbi } from "./abis/VerifierRouter";
import type { creditVerifierRouterAbi } from "./abis/CreditVerifierRouter";
import type { invisiAddressRegistryAbi } from "./abis/InvisiAddressRegistry";
export type InvisiCoreAbi = typeof invisiCoreAbi;
export type InvisiCoreFactoryAbi = typeof invisiCoreFactoryAbi;
export type VerifierRouterAbi = typeof verifierRouterAbi;
export type CreditVerifierRouterAbi = typeof creditVerifierRouterAbi;
export type InvisiAddressRegistryAbi = typeof invisiAddressRegistryAbi;
import type { Hex, Address } from "@invisi-labs/primitives";
export type { Hex, Address } from "@invisi-labs/primitives";
export interface InputSource {
    treeId: bigint;
    merkleRoot: Hex;
}
export interface TokenPermit {
    deadline: bigint;
    v: number;
    r: Hex;
    s: Hex;
}
export interface FundingParams {
    payer: Address;
    amount: bigint;
    sigNonce: bigint;
    deadline: bigint;
    signature: Hex;
    permit: TokenPermit;
}
export interface ShieldParams {
    token: Address;
    noteCommitments: readonly Hex[];
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
export interface ShieldOutput {
    identity: Hex;
    amount: bigint;
}
export interface Delivery {
    ciphertext: Hex;
    clue: Hex;
}
export interface CrossTreeTransactParams {
    token: Address;
    sources: readonly InputSource[];
    nullifiers: readonly Hex[];
    noteCommitments: readonly Hex[];
    withdrawalAddress: Address;
    withdrawalAmount: bigint;
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
export interface TransactRequest {
    params: CrossTreeTransactParams;
    deliveries: readonly Delivery[];
    funding: FundingParams;
}
export interface CreateCreditParams {
    token: Address;
    owner: Address;
    revocationShard: bigint;
    revocationSlot: bigint;
    creditCommitment: Hex;
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
/** Omit hasFirstDraw to use the legacy deployed ABI. Set false for pure creation on the new ABI. */
export type CreditCreationParams = CreateCreditParams &
    (
        | { hasFirstDraw?: undefined; totalAmount?: never; noteCommitment?: never }
        | { hasFirstDraw: false; totalAmount?: 0n; noteCommitment?: Hex }
        | { hasFirstDraw: true; totalAmount: bigint; noteCommitment: Hex }
    );
export interface CreditPayer {
    payer: Address;
    amount: bigint;
}
export interface CreditGrantRef {
    payerIndex: bigint;
    shard: bigint;
    slot: bigint;
}
export interface CreditDrawParams {
    token: Address;
    sources: readonly InputSource[];
    payers: readonly CreditPayer[];
    grantRefs: readonly CreditGrantRef[];
    nullifiers: readonly Hex[];
    creditCommitments: readonly Hex[];
    recoveryAmounts: readonly Hex[];
    noteCommitment: Hex;
    totalAmount: bigint;
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
export interface UpdateCreditParams {
    token: Address;
    owner: Address;
    source: InputSource;
    nullifier: Hex;
    creditCommitment: Hex;
    revocationShard: bigint;
    revocationSlot: bigint;
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
export interface RevokeCreditParams {
    token: Address;
    owner: Address;
    shard: bigint;
    slot: bigint;
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
export interface ReceivingKeys {
    viewingPublicKey: Hex;
    clueKey: Hex;
}
export interface AddressRegistration {
    ownerAddress: Hex;
    keys: ReceivingKeys;
    nonce: bigint;
    deadline: bigint;
}
