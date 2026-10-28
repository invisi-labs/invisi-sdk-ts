import type { WalletSession, Operation } from "@invisi-labs/sdk";
import { useOperation } from "@invisi-labs/react";

/** The caller supplies a connected browser session. Amounts use token base units. */
export function Transfer({
    session,
    recipient,
    confirm,
}: {
    session: WalletSession;
    recipient: string;
    confirm(review: ReturnType<Operation["preview"]>, signal: AbortSignal): Promise<boolean>;
}) {
    const state = useOperation();

    async function send() {
        // Each visible action uses the same immutable operation and the same injected session.
        const prepared = await state.run(async () =>
            session.prepareTransfer({
                tokenAddress: "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6" as const,
                outputs: [{ to: recipient, amount: 30n }],
            })
        );

        // The application owns the review UI; a declined review safely releases this prepared operation.
        const authorized = await state.run(async (signal) => {
            const accepted = await confirm(prepared.preview(), signal);
            signal.throwIfAborted();
            return accepted ? prepared.authorize({ signal }) : prepared.abandon();
        });
        if (authorized.status === "failed") return;

        const proved = await state.run((signal) =>
            authorized.prove({
                signal,
                onProgress: (event) => console.log("Proof phase:", event.phase),
            })
        );

        await state.run(async (signal) => {
            signal.throwIfAborted();
            // The session's injected ethers signer sends; cancellation cannot revoke that send.
            const transaction = await session.sendTransaction(proved);
            const receipt = await transaction.wait();
            if (!receipt) throw new Error("Receipt is not available; retain reservations");
            const tracked = await session.resume(proved.id);
            return tracked.reconcile({ signal });
        });
    }

    return (
        <div>
            <button disabled={state.status === "running"} onClick={() => void send().catch(() => {})}>
                Transfer
            </button>
            <button onClick={state.cancel}>Cancel local work</button>
            <output>{state.status}</output>
            {state.error && <p>{state.error.message}</p>}
        </div>
    );
}
