import { it, expect } from "vitest";
import {
    PublicWallet,
    computeCreditCommitment,
    normalizeCreditPolicy,
    type CreditDeliveryState,
} from "@invisi-labs/core";
import { Wallet as EvmWallet, Interface } from "ethers";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { setup, externallyAuthorize } from "./ExplicitTransaction-fixtures";
const real = process.env.BB_BINARY_PATH || process.env.INVISI_TEST_WASM === "1" ? it : it.skip;
real(
    "proves current create/update/draw fee witnesses with owner pulls, net Notes and gross usage",
    async () => {
        const h = await setup(),
            prover =
                process.env.INVISI_TEST_WASM === "1"
                    ? new (await import("@invisi-labs/prover/wasm")).WasmProver({ threads: 4 })
                    : new (await import("@invisi-labs/prover/native")).NativeProver({
                          bbBin: process.env.BB_BINARY_PATH!,
                          threads: 4,
                      }),
            state: CreditDeliveryState = {
                note: {
                    chainId: h.context.chainId,
                    protocolAddress: BigInt(h.context.protocolAddress),
                    tokenAddress: BigInt(h.context.tokenAddress),
                    ownerWalletIdentity: h.wallet.ownerAddress,
                    spenderWalletIdentity: h.bob.ownerAddress,
                    revocationShard: 1n,
                    revocationSlot: 0n,
                    nonce: 456n,
                    expiry: 2000003600n,
                    creditSharedKey: 789n,
                    ...normalizeCreditPolicy({ singleLimit: 50n, lifetimeLimit: 100n }),
                },
                ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
                spenderReceivingKeys: h.bob.getReceivingAddress().getReceivingKeys(),
            },
            commitment = await computeCreditCommitment(state.note);
        await h.tree.insert(BigInt(commitment));
        const identity = {
                wallet: PublicWallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
            },
            input = { state, commitment, treeId: 1n, leafIndex: 1, role: "owner" as const },
            fee = { recipient: h.bob.ownerAddress, amount: 3n },
            create = await h.invisi.prepareCreateCredit({
                ...identity,
                spender: h.bob.getAddress(),
                expiry: state.note.expiry,
                fee,
            }),
            update = await h.invisi.prepareUpdateCredit({
                ...identity,
                creditInputs: [input],
                credit: commitment,
                singleLimit: 10n,
                fee,
            }),
            draw = await h.invisi.prepareDrawCredit({
                ...identity,
                wallet: PublicWallet.fromAddress(h.bob.getAddress()),
                creditInputs: [{ ...input, role: "spender" }],
                credits: [{ credit: commitment, amount: 30n }],
                recipient: h.wallet.getAddress(),
                fee,
            });
        for (const prepared of [create, update, draw]) {
            const signer = new EvmWallet(
                    `0x${(prepared.kind === "draw-credit" ? "02" : "01").repeat(32)}`
                ),
                ready = await (await externallyAuthorize(prepared, signer)).prove(prover);
            expect(ready.exportProof().proofHex.length).toBeGreaterThan(1000);
            const decoded = new Interface(invisiProtocolAbi).parseTransaction(
                await ready.exportTransaction()
            )!;
            expect(decoded.args[1].feeAmount).toBe(3n);
            if (prepared.kind === "draw-credit") {
                expect(ready.getOutputs()[0]!.amount).toBe(27n);
                expect(decoded.args[1].totalAmount).toBe(30n);
            }
        }
    },
    600000
);
