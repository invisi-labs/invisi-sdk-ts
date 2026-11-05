import type { Hex } from "@invisi-labs/protocol/contracts";
import { Interface, keccak256 } from "ethers";

import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Disclosure, ViewingCapability } from "@invisi-labs/core";
import { TokenProtocol, type CanonicalReceipt, type ChainReader } from "@invisi-labs/protocol";
import { describe, expect, it } from "vitest";
import clues from "../../../core/src/testdata/fmd-rust-vectors.json";
import vectors from "../../../core/src/testdata/wallet-note-vectors.json";
import * as wallet from "../index";

const hex = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`;
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: vectors.context.protocolAddress as Hex,
    tokenAddress: vectors.context.tokenAddress as Hex,
};
const reference = { transactionHash: hex(101n), treeId: 1n, leafIndex: 0, role: "funds" as const };
const block = { number: 12n, hash: hex(12n), parentHash: hex(11n), timestamp: 1000n };

function log(name: string, args: Record<string, unknown>, logIndex: number) {
    const event = invisiProtocolAbi.find((entry) => entry.type === "event" && entry.name === name)!;
    if (event.type !== "event") throw new Error("missing event");
    const inputs = event.inputs.filter((input) => !input.indexed);
    return {
        address: context.protocolAddress,
        transactionHash: reference.transactionHash,
        logIndex,
        topics: new Interface([event]).encodeEventLog(
            name,
            event.inputs.map((input) => args[input.name])
        ).topics as Hex[],
        data: new Interface([event]).encodeEventLog(
            name,
            event.inputs.map((input) => args[input.name])
        ).data as Hex,
    };
}

async function harness() {
    const receipt: CanonicalReceipt = {
        block,
        transactionHash: reference.transactionHash,
        status: "success",
        logs: [
            log(
                "CommitmentsInserted",
                { treeId: 1n, startLeafIndex: 0, commitments: [vectors.note.commitment] },
                0
            ),
            log(
                "Shield",
                {
                    token: context.tokenAddress,
                    payer: context.protocolAddress,
                    amount: 70n,
                    treeId: 1n,
                    startLeafIndex: 0,
                    deliveries: [
                        {
                            ciphertext: vectors.note.ciphertext,
                            clue: `0x${clues.vectors[0]!.clue}`,
                        },
                    ],
                    deadline: 2000n,
                },
                1
            ),
        ],
    };
    const current = {
        receipt: receipt as CanonicalReceipt | null,
        chainId: context.chainId,
        blockHash: block.hash,
        head: 13n,
        blockReads: 0,
        reorgAfterRead: false,
    };
    const reader = {
        getChainId: async () => current.chainId,
        getCode: async () => "0x01" as Hex,
        getLatestBlockNumber: async () => current.head,
        getReceipt: async () => current.receipt,
        getBlock: async () => {
            current.blockReads++;
            return {
                ...block,
                hash:
                    current.reorgAfterRead && current.blockReads > 1 ? hex(99n) : current.blockHash,
            };
        },
    } satisfies Pick<
        ChainReader,
        "getChainId" | "getCode" | "getLatestBlockNumber" | "getReceipt" | "getBlock"
    >;
    const protocol = new TokenProtocol(context, {
        expectedRuntimeCodeHash: keccak256("0x01") as Hex,
    });
    const viewing = new ViewingCapability(
        `0x${BigInt(vectors.note.ownerAddress).toString(16).padStart(40, "0")}` as Hex,
        vectors.owner.viewingPrivateKey as Hex
    );
    const disclosure = await viewing.discloseNote(vectors.note.ciphertext as Hex, {
        chainId: context.chainId,
        protocolAddress: BigInt(context.protocolAddress),
        tokenAddress: BigInt(context.tokenAddress),
        outputCommitment: vectors.note.commitment as Hex,
    });
    return { current, reader, protocol, disclosure };
}

describe("canonical disclosure verifier", () => {
    it("rejects an output for another token before returning canonical evidence", async () => {
        const h = await harness();
        const receipt = structuredClone(h.current.receipt!);
        receipt.logs = [
            receipt.logs[0]!,
            log(
                "Shield",
                {
                    token: "0x2222222222222222222222222222222222222222",
                    payer: context.protocolAddress,
                    amount: 70n,
                    treeId: 1n,
                    startLeafIndex: 0,
                    deliveries: [
                        {
                            ciphertext: vectors.note.ciphertext,
                            clue: `0x${clues.vectors[0]!.clue}`,
                        },
                    ],
                    deadline: 2000n,
                },
                1
            ),
        ];
        h.current.receipt = receipt;
        await expect(
            new wallet.DisclosureVerifier({ protocol: h.protocol, reader: h.reader }).readOutput(
                reference
            )
        ).rejects.toThrow();
    });

    it("rejects an RPC chain switch during the final confirmation read", async () => {
        const h = await harness();
        let reads = 0;
        const reader = {
            ...h.reader,
            getLatestBlockNumber: async () => {
                if (++reads === 2) h.current.chainId++;
                return h.current.head;
            },
        };
        await expect(
            new wallet.DisclosureVerifier({ protocol: h.protocol, reader }).verify(
                h.disclosure,
                reference
            )
        ).rejects.toThrow(/chain/);
    });

    it("resolves real encoded insertion and delivery logs without wallet permissions", async () => {
        const h = await harness();
        const verifier = new wallet.DisclosureVerifier({
            protocol: h.protocol,
            reader: h.reader,
            confirmations: 2,
        });
        const result = await verifier.verify(
            await Disclosure.fromExport(h.disclosure.export()),
            reference
        );
        expect(result.result.kind).toBe("note");
        expect(result.result.note.amount).toBe(BigInt(vectors.note.amount));
        expect(result.output.commitment).toBe(vectors.note.commitment);
        expect(result.output.transactionHash).toBe(reference.transactionHash);
        expect(result.block.hash).toBe(block.hash);
        expect(result.confirmations).toBe(2n);
    });

    it.each([
        "missing",
        "reverted",
        "unconfirmed",
        "transaction",
        "log-transaction",
        "insertion",
        "delivery",
    ])("rejects %s receipt evidence", async (failure) => {
        const h = await harness();
        const receipt = structuredClone(h.current.receipt!);
        if (failure === "missing") h.current.receipt = null;
        else if (failure === "reverted") receipt.status = "reverted";
        else if (failure === "unconfirmed") h.current.head = 11n;
        else if (failure === "transaction") receipt.transactionHash = hex(102n);
        else if (failure === "log-transaction")
            receipt.logs = receipt.logs.map((entry) => ({ ...entry, transactionHash: hex(102n) }));
        else if (failure === "insertion") receipt.logs = receipt.logs.slice(1);
        else if (failure === "delivery") receipt.logs = receipt.logs.slice(0, 1);
        if (failure !== "missing") h.current.receipt = receipt;
        await expect(
            new wallet.DisclosureVerifier({ protocol: h.protocol, reader: h.reader }).verify(
                h.disclosure,
                reference
            )
        ).rejects.toThrow();
    });

    it("rejects a different leaf or role and a reorg during verification", async () => {
        const h = await harness();
        const verifier = new wallet.DisclosureVerifier({ protocol: h.protocol, reader: h.reader });
        await expect(
            verifier.verify(h.disclosure, { ...reference, leafIndex: 1 })
        ).rejects.toThrow();
        await expect(
            verifier.verify(h.disclosure, { ...reference, role: "owner" })
        ).rejects.toThrow();
        h.current.blockReads = 0;
        h.current.reorgAfterRead = true;
        await expect(verifier.verify(h.disclosure, reference)).rejects.toThrow(/canonical|reorg/);
    });

    it("enforces deployment profile, chain identity and requested confirmations", async () => {
        const h = await harness();
        await expect(
            new wallet.DisclosureVerifier({
                protocol: new TokenProtocol(context),
                reader: h.reader,
            }).verify(h.disclosure, reference)
        ).rejects.toThrow(/profile/);
        await expect(
            new wallet.DisclosureVerifier({
                protocol: h.protocol,
                reader: h.reader,
                confirmations: 3,
            }).verify(h.disclosure, reference)
        ).rejects.toThrow(/confirm/);
        h.current.chainId++;
        await expect(
            new wallet.DisclosureVerifier({ protocol: h.protocol, reader: h.reader }).verify(
                h.disclosure,
                reference
            )
        ).rejects.toThrow(/chain/);
    });
});
