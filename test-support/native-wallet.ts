import { LocalWallet } from "@invisi-labs/core/local";
import type { WalletRequest, WalletResponse } from "@invisi-labs/core";
import type { Operation } from "../packages/session/src/operations/Operation";
import type { PendingWalletRefresh } from "../packages/session/src/sync/WalletRefresh";
import type { WalletSession } from "../packages/session/src/wallet/WalletSession";
import type { RefreshOptions } from "../packages/session/src/sync/refresh";

export async function executeWalletRequest(request: WalletRequest): Promise<WalletResponse> {
    for (const number of [1, 2]) {
        const local = await LocalWallet.fromPrivateKey(new Uint8Array(32).fill(number));
        if (local.ownerAddress === request.ownerAddress) return local.execute(request);
        const vector = await LocalWallet.fromPrivateKey(
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
export async function applyRefresh(pending: PendingWalletRefresh) {
    return pending.applyWalletResponses(
        await Promise.all(
            pending.walletRequests.map(async (request) => {
                let response: WalletResponse | null;
                try {
                    response = await executeWalletRequest(request);
                } catch {
                    response = null;
                }
                return { requestId: request.id, response };
            })
        )
    );
}
export async function refreshSession(session: WalletSession, options: RefreshOptions) {
    return applyRefresh(await session.refresh(options));
}
