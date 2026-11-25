import assert from "node:assert/strict";
import { test } from "node:test";
import { Wallet, NoteOutput } from "../../packages/sdk/dist/index.js";
import { readFileSync } from "node:fs";
import { discoverCandidates } from "../../examples/03-hidden-amount/discover-candidates.js";
import { discoverCredits } from "../../examples/04-credit/discover-credits.js";

for (const outcome of ["not-recipient", "candidate", "unresolved"] as const)
    test(`Note discovery handles ${outcome} without hiding authentication failures`, async () => {
        const fixture = JSON.parse(
            readFileSync(
                new URL(
                    "../../packages/primitives/src/wallet/testdata/receiving-signature-v1-vectors.json",
                    import.meta.url
                ),
                "utf8"
            )
        );
        const wallet = Wallet.fromAddress(fixture.vectors[0].receivingAddress);
        const context = {
            chainId: 97n,
            protocolAddress: "0x54c2137a2380a9097A6771D8BB660E889a3A6e84" as const,
        };
        const tokenAddress = "0xf78DB005c9af4e9Ce4ebE6A5C162f9C42f2E4b65" as const;
        const output = await NoteOutput.create({
            ...context,
            tokenAddress,
            amount: 1n,
            recipient: { type: "invisi", address: fixture.vectors[1].receivingAddress },
        });
        let decryptions = 0,
            detections = 0;
        const head = { number: 1n, hash: "0x" + "11".repeat(32), timestamp: 1 };
        const rpc = {
            withProvider() {
                return this;
            },
            async getStatus() {
                return { indexedHead: head };
            },
            async getNoteUpdates() {
                return {
                    block: head,
                    notes: [
                        {
                            tokenAddress,
                            commitment: output.commitment,
                            ciphertext: output.preparedOutput.delivery.ciphertext,
                            clue: output.preparedOutput.delivery.clue,
                            treeId: 0n,
                            leafIndex: 0n,
                            transactionHash: "0x" + "22".repeat(32),
                            block: head,
                        },
                    ],
                };
            },
        };
        const protocol = {
            context,
            deployment: { protocol: { fromBlock: 1n } },
            forToken() {
                return this;
            },
        };
        const pending = discoverCandidates({
            provider: {} as never,
            protocolRpc: rpc as never,
            protocol: protocol as never,
            wallet,
            tokenAddress,
            decryptor: {
                async detect() {
                    detections++;
                    return { ownerAddress: wallet.ownerAddress, results: [outcome] };
                },
                async decryptNote() {
                    decryptions++;
                    return { status: "authentication-failed" as const };
                },
                async decryptCredit() {
                    throw Error("unexpected Credit");
                },
            },
        });
        if (outcome === "not-recipient") assert.deepEqual(await pending, []);
        else
            await assert.rejects(
                pending,
                outcome === "candidate" ? /authentication/i : /unresolved/i
            );
        assert.equal(detections, 1);
        assert.equal(decryptions, outcome === "candidate" ? 1 : 0);
    });

for (const role of ["owner", "spender"] as const)
    for (const outcome of ["not-recipient", "candidate", "unresolved"] as const)
        test(`Credit ${role} discovery handles ${outcome} without hiding authentication failures`, async () => {
            const vectors = JSON.parse(
                readFileSync(
                    new URL(
                        "../../packages/primitives/src/wallet/testdata/receiving-signature-v1-vectors.json",
                        import.meta.url
                    ),
                    "utf8"
                )
            );
            const credit = JSON.parse(
                readFileSync(
                    new URL(
                        "../../packages/primitives/src/wallet/testdata/wallet-note-vectors.json",
                        import.meta.url
                    ),
                    "utf8"
                )
            ).credit;
            const wallet = Wallet.fromAddress(vectors.vectors[0].receivingAddress);
            const context = {
                chainId: 97n,
                protocolAddress: "0x54c2137a2380a9097A6771D8BB660E889a3A6e84" as const,
            };
            const tokenAddress = "0xf78DB005c9af4e9Ce4ebE6A5C162f9C42f2E4b65" as const;
            const hash = "0x" + "22".repeat(32);
            const head = { number: 1n, hash, timestamp: 1 };
            const state = {
                tokenAddress,
                commitment: credit.commitment,
                treeId: 0n,
                leafIndex: 0n,
                transactionHash: hash,
                block: head,
                deliveries: [
                    { ciphertext: credit.ownerCiphertext, clue: "0x00" },
                    { ciphertext: credit.spenderCiphertext, clue: "0x00" },
                ],
            };
            const rpc = {
                withProvider() {
                    return this;
                },
                async getStatus() {
                    return { indexedHead: head };
                },
                async getCreditTransitions() {
                    return { transitions: [{ transactionHash: hash }] };
                },
                async getTransactionCreditUpdates() {
                    return { status: "indexed", states: [state] };
                },
            };
            const protocol = {
                context,
                deployment: { protocol: { fromBlock: 1n } },
                forToken() {
                    return this;
                },
            };
            let detections = 0;
            const pending = discoverCredits({
                provider: {} as never,
                protocolRpc: rpc as never,
                protocol: protocol as never,
                wallet,
                tokenAddress,
                role,
                decryptor: {
                    async detect(candidates) {
                        detections++;
                        assert.equal(candidates[0].role, role);
                        assert.equal(candidates[0].ownerAddress, wallet.ownerAddress);
                        assert.equal(
                            candidates[0].ciphertext,
                            state.deliveries[role === "owner" ? 0 : 1].ciphertext
                        );
                        return { ownerAddress: wallet.ownerAddress, results: [outcome] };
                    },
                    async decryptNote() {
                        throw Error("unexpected Note");
                    },
                    async decryptCredit(_envelope, context) {
                        assert.equal(context.role, role);
                        return { status: "authentication-failed" as const };
                    },
                },
            });
            if (outcome === "not-recipient") assert.deepEqual(await pending, []);
            else
                await assert.rejects(
                    pending,
                    outcome === "candidate" ? /authentication/i : /unresolved/i
                );
            assert.equal(detections, 1);
        });
