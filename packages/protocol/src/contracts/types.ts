import type { invisiProtocolAbi } from "./abis/InvisiProtocol";
import type { invisiFactoryAbi } from "./abis/InvisiFactory";
import type { verifierRouterAbi } from "./abis/VerifierRouter";
import type { creditVerifierRouterAbi } from "./abis/CreditVerifierRouter";
import type { invisiAddressRegistryAbi } from "./abis/InvisiAddressRegistry";
export type InvisiProtocolAbi = typeof invisiProtocolAbi;
export type InvisiFactoryAbi = typeof invisiFactoryAbi;
export type VerifierRouterAbi = typeof verifierRouterAbi;
export type CreditVerifierRouterAbi = typeof creditVerifierRouterAbi;
export type InvisiAddressRegistryAbi = typeof invisiAddressRegistryAbi;
import type { Hex, Address } from "@invisi-labs/core";
export type { Hex, Address } from "@invisi-labs/core";
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
    outputCommitments: readonly Hex[];
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
    outputCommitments: readonly Hex[];
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
    sources: readonly InputSource[];
    nullifiers: readonly Hex[];
    creditCommitment: Hex;
    changeCommitment: Hex;
    owner: Address;
    expiry: bigint;
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
export interface CreditDrawParams {
    token: Address;
    sources: readonly InputSource[];
    nullifiers: readonly Hex[];
    remainderCommitments: readonly Hex[];
    expiries: readonly bigint[];
    recoveryAmounts: readonly Hex[];
    spender: Address;
    totalAmount: bigint;
    deadline: bigint;
}
export interface CancelCreditParams {
    token: Address;
    source: InputSource;
    nullifier: Hex;
    owner: Address;
    amount: bigint;
    deadline: bigint;
    feeRecipient?: Address;
    feeAmount?: bigint;
}
export interface TopUpCreditParams {
    creation: CreateCreditParams;
    creditSource: InputSource;
    creditNullifier: Hex;
    previousExpiry: bigint;
}
export interface ReceivingKeys {
    viewingPublicKey: Hex;
    clueKey: Hex;
}
export interface AddressRegistration {
    walletIdentity: Hex;
    keys: ReceivingKeys;
    nonce: bigint;
    deadline: bigint;
}
