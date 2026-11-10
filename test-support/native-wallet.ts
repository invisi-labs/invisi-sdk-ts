import { TestWallet } from "./test-wallet";
import type { DeliveryDecryptor, WalletRequest, WalletResponse } from "@invisi-labs/primitives";
import type { Operation } from "../packages/session/src/operations/Operation";
import type { PendingWalletRefresh } from "../packages/session/src/sync/WalletRefresh";
import type { WalletSession } from "../packages/session/src/wallet/WalletSession";
import type { RefreshOptions } from "../packages/session/src/sync/refresh";

export async function executeWalletRequest(request: WalletRequest): Promise<WalletResponse> {
    for (const number of [1, 2]) {
        const local = await TestWallet.fromPrivateKey(new Uint8Array(32).fill(number));
        if (local.ownerAddress === request.ownerAddress) return local.execute(request);
        const vector = await TestWallet.fromPrivateKey(
            `0x${number.toString(16).padStart(64, "0")}`
        );
        if (vector.ownerAddress === request.ownerAddress) return vector.execute(request);
    }
    throw new Error("unknown test wallet");
}
export async function authorizeOperation(operation: Operation): Promise<Operation> {
    const request = await operation.exportWalletRequest(crypto.randomUUID());
    return operation.withWalletResponse(await executeWalletRequest(request));
}
export async function executeWalletRequests(requests: WalletRequest[]): Promise<WalletResponse[]> {
    const { validateWalletBatch } = await import("@invisi-labs/primitives");
    validateWalletBatch(requests);
    return Promise.all(
        requests.map(async (request) => {
            try {
                return await executeWalletRequest(request);
            } catch (error) {
                const nonrecipient =
                    (request.method === "wallet.decryptNote" ||
                        request.method === "wallet.decryptCredit") &&
                    error instanceof Error &&
                    error.name === "OperationError";
                return {
                    version: request.version,
                    id: request.id,
                    ownerAddress: request.ownerAddress,
                    method: request.method,
                    error: {
                        code: nonrecipient ? "WALLET_NOT_RECIPIENT" : "WALLET_EXECUTION_FAILED",
                    },
                };
            }
        })
    );
}
export async function applyRefresh(pending: PendingWalletRefresh) {
    return pending.decrypt(testDecryptor);
}
export async function refreshSession(session: WalletSession, options: RefreshOptions) {
    return applyRefresh(await session.refresh(options));
}

export const testDecryptor: DeliveryDecryptor = {
    decryptNote: (envelope, context) => decryptForTest("wallet.decryptNote", envelope, context),
    decryptCredit: (envelope, context) => decryptForTest("wallet.decryptCredit", envelope, context),
};
async function decryptForTest(
    method: "wallet.decryptNote" | "wallet.decryptCredit",
    envelope: import("@invisi-labs/primitives").NoteBytes,
    context:
        | import("@invisi-labs/primitives").NoteDecryptionContext
        | import("@invisi-labs/primitives").CreditStateDecryptionContext
): Promise<Uint8Array | null> {
    const { hexlify, getBytes } = await import("ethers");
    try {
        const response = await executeWalletRequest({
            version: 1,
            id: crypto.randomUUID(),
            ownerAddress: context.ownerAddress,
            method,
            params: {
                envelope: hexlify(envelope) as `0x${string}`,
                context: {
                    chainId: context.chainId.toString(),
                    protocolAddress: BigInt(context.protocolAddress).toString(),
                    tokenAddress: context.tokenAddress.toString(),
                    outputCommitment: context.outputCommitment,
                    ...("role" in context ? { role: context.role } : {}),
                },
            },
        });
        if ("error" in response) throw new Error(response.error!.code);
        return getBytes((response.result as { plaintext: string }).plaintext);
    } catch (error) {
        if (error instanceof Error && error.name === "OperationError") return null;
        throw error;
    }
}
