import { computeNoteCommitment } from "@invisi-labs/core";
import { expect, it } from "vitest";
import { TokenProtocol, WitnessBuilder } from "../index";
const context = {
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x2222222222222222222222222222222222222222",
} as const;
it("builds funded witnesses from randomized output identities without note openings", async () => {
    const outputs = [1n, 2n].map((i) => ({
        identity: ("0x" + i.toString(16).padStart(64, "0")) as `0x${string}`,
        amount: 50n,
    }));
    const commitments = await Promise.all(
        outputs.map((o) =>
            computeNoteCommitment(
                context.chainId,
                BigInt(context.protocolAddress),
                o.identity,
                BigInt(context.tokenAddress),
                o.amount
            )
        )
    );
    const build = (noteCommitments = commitments) =>
        new WitnessBuilder(new TokenProtocol(context)).transact({
            inputs: [],
            outputs,
            deliveries: outputs.map(() => ({ ciphertext: "0x", clue: "0x" })),
            params: {
                token: context.tokenAddress,
                sources: [],
                nullifiers: [],
                noteCommitments,
                withdrawalAddress: "0x0000000000000000000000000000000000000000",
                withdrawalAmount: 0n,
                deadline: 100n,
            },
            funding: { payer: context.protocolAddress, amount: 100n },
        });
    await expect(build()).resolves.toMatchObject({ circuitName: "transact_user_slots2" });
    await expect(build([...commitments].reverse())).rejects.toThrow("output commitment mismatch");
});
