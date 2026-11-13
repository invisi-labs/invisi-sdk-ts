// Test-only deterministic quote service. No network access or real transaction submission.
import { Wallet } from "ethers";
import {
    BroadcasterClient,
    broadcasterRequestHash,
    broadcasterQuoteDomain,
    broadcasterQuoteTypes,
    scheduledBroadcasterQuoteTypes,
    type BroadcasterSchedule,
    decodeBroadcasterIntent,
} from "@invisi-labs/sdk";
export function quoteClient(
    context: { chainId: bigint; protocolAddress: string },
    amount: () => bigint = () => 10n
) {
    const signer = new Wallet(`0x${"03".repeat(32)}`);
    const trust = {
        chainId: context.chainId,
        protocol: context.protocolAddress,
        signer: signer.address,
    };
    return new BroadcasterClient(
        {
            endpoint: "https://broadcaster.test",
            quoteSigner: trust.signer,
            feeRecipient: trust.signer,
        },
        async (request) => {
            const result = (value: unknown) => ({ jsonrpc: "2.0", id: request.id, result: value });
            if (request.method === "broadcaster_estimateQuote")
                return result({
                    feeRecipient: signer.address,
                    feeAmount: String(amount()),
                    maxGas: "2000000",
                });
            if (request.method === "broadcaster_getStatus")
                return result({
                    apiVersion: "v1",
                    protocolVersion: "1",
                    chainId: context.chainId.toString(),
                    protocol: context.protocolAddress,
                    sender: signer.address,
                    feeRecipient: signer.address,
                    submissionHalted: false,
                    provenance: { enabled: false },
                    scheduling: {
                        enabled: true,
                        maxDelaySeconds: "604800",
                        defaultExecutionWindowSeconds: "300",
                        maxExecutionWindowSeconds: "3600",
                        minDeadlineSlackSeconds: "120",
                    },
                });
            const { data, schedule } = (request.params as unknown[])[0] as {
                data: string;
                schedule?: BroadcasterSchedule;
            };
            const params = decodeBroadcasterIntent(data).request.params;
            const quote = {
                ...(schedule ? { schedule } : {}),
                token: params.token,
                feeRecipient: params.feeRecipient,
                feeAmount: String(params.feeAmount),
                deadline: String(params.deadline),
                maxGas: "2000000",
                requestHash: broadcasterRequestHash(data),
                execution: "direct",
            };
            return result({
                quote,
                signature: await signer.signTypedData(
                    broadcasterQuoteDomain(trust),
                    schedule ? scheduledBroadcasterQuoteTypes : broadcasterQuoteTypes,
                    schedule ? { ...quote, ...schedule } : quote
                ),
            });
        }
    );
}
