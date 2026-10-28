import type { WalletSession, Operation } from "@invisi-labs/sdk";
import { useOperation } from "@invisi-labs/vue";

/** Use in a setup scope. Cancel stops work; a submitted transaction remains recoverable. */
export function useTransfer(
    session: WalletSession,
    confirm: (review: ReturnType<Operation["preview"]>, signal: AbortSignal) => Promise<boolean>
) {
    const state = useOperation();

    async function send(recipient: string) {
        const prepared = await state.run(async () =>
            session.prepareTransfer({
                tokenAddress: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const,
                outputs: [{ to: recipient, amount: 30n }],
            })
        );

        // Review belongs to the application's UI, not the SDK or a comment-only placeholder.
        const authorized = await state.run(async (signal) => {
            const accepted = await confirm(prepared.preview(), signal);
            signal.throwIfAborted();
            return accepted ? prepared.authorize({ signal }) : prepared.abandon();
        });
        if (authorized.status === "failed") return authorized;

        const proved = await state.run((signal) =>
            authorized.prove({
                signal,
                onProgress: (event) => console.log("Proof phase:", event.phase),
            })
        );

        return state.run(async (signal) => {
            signal.throwIfAborted();
            const transaction = await session.sendTransaction(proved);
            const receipt = await transaction.wait();
            if (!receipt) throw new Error("Receipt is not available; retain reservations");
            const tracked = await session.resume(proved.id);
            return tracked.reconcile({ signal });
        });
    }

    return { ...state, send };
}
