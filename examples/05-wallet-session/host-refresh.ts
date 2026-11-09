import type { LocalWallet } from "@invisi-labs/core/local";
import type { WalletSession } from "@invisi-labs/session";

/** Node example host. Mobile hosts run each request through their native Vault. */
export async function refreshFromHost(session: WalletSession, executor: LocalWallet, options: Parameters<WalletSession["refresh"]>[0]) {
    const pending = await session.refresh(options);
    const responses = await Promise.all(
        pending.walletRequests.map(async (request) => {
            try {
                return { requestId: request.id, response: await executor.execute(request) };
            } catch (error) {
                // AEAD rejection is an explicit nonrecipient outcome; host/unlock errors propagate.
                if (
                    error instanceof Error &&
                    error.name === "OperationError" &&
                    (request.method === "wallet.decryptNote" || request.method === "wallet.decryptCredit")
                ) {
                    return { requestId: request.id, response: null };
                }
                throw error;
            }
        })
    );
    return pending.applyWalletResponses(responses);
}
