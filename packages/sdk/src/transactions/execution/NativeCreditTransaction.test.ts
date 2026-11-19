import { testResourceOptions } from "../../../../prover/src/testing/resource-options";
import { legacyCreateCreditAbi } from "@invisi-labs/protocol";
import { it, expect } from "vitest";
import {
    Wallet,
    computeCreditCommitment,
    normalizeCreditPolicy,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
import { Wallet as EvmWallet, Interface } from "ethers";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { setup, externallyAuthorize } from "./ExplicitTransaction-fixtures";
const real = process.env.BB_BINARY_PATH || process.env.INVISI_TEST_WASM === "1" ? it : it.skip;
real(
    "proves current quota deltas, both mode switches and gross draw fees with net Notes",
    async () => {
        const h = await setup(),
            prover =
                process.env.INVISI_TEST_WASM === "1"
                    ? new (await import("@invisi-labs/prover/wasm")).WasmProver({
                          threads: 4,
                          resources: testResourceOptions,
                      })
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
                    availableCredit: 100n,
                    unlimited: false,
                    ...normalizeCreditPolicy({ singleLimit: 50n }),
                },
                ownerReceivingKeys: h.wallet.getReceivingAddress().getReceivingKeys(),
                spenderReceivingKeys: h.bob.getReceivingAddress().getReceivingKeys(),
            },
            commitment = await computeCreditCommitment(state.note);
        await h.tree.insert(BigInt(commitment));
        const unlimitedState = {
            ...state,
            note: { ...state.note, availableCredit: 0n, unlimited: true, nonce: 457n },
        };
        const unlimitedCommitment = await computeCreditCommitment(unlimitedState.note);
        await h.tree.insert(BigInt(unlimitedCommitment));
        const identity = {
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
            },
            input = { state, commitment, treeId: 1n, leafIndex: 1, role: "owner" as const },
            fee = { recipient: h.bob.ownerAddress, amount: 3n },
            create = await h.invisi.prepareCreateCredit({
                ...identity,
                spender: h.bob.getAddress(),
                expiry: state.note.expiry,
                availableCredit: 100n,
                unlimited: false,
                fee,
            }),
            update = await h.invisi.prepareUpdateCredit({
                ...identity,
                creditInputs: [input],
                credit: commitment,
                singleLimit: 10n,
                increaseAvailableCredit: 10n,
                fee,
            }),
            draw = await h.invisi.prepareDrawCredit({
                ...identity,
                wallet: Wallet.fromAddress(h.bob.getAddress()),
                creditInputs: [{ ...input, role: "spender" }],
                credits: [{ credit: commitment, amount: 30n }],
                recipient: h.wallet.getAddress(),
                fee,
            });
        const clear = await h.invisi.prepareUpdateCredit({
            ...identity,
            creditInputs: [input],
            credit: commitment,
            unlimited: true,
            fee,
        });
        const finite = await h.invisi.prepareUpdateCredit({
            ...identity,
            creditInputs: [
                {
                    state: unlimitedState,
                    commitment: unlimitedCommitment,
                    treeId: 1n,
                    leafIndex: 2,
                    role: "owner",
                },
            ],
            credit: unlimitedCommitment,
            unlimited: false,
            increaseAvailableCredit: 15n,
            fee,
        });
        for (const prepared of [create, update, draw, clear, finite]) {
            const signer = new EvmWallet(
                    `0x${(prepared.kind === "draw-credit" ? "02" : "01").repeat(32)}`
                ),
                ready = await (await externallyAuthorize(prepared, signer)).prove(prover);
            expect(ready.exportProof().proofHex.length).toBeGreaterThan(1000);
            const decoded = new Interface([
                ...invisiCoreAbi,
                ...legacyCreateCreditAbi,
            ]).parseTransaction(await ready.exportTransaction())!;
            expect(decoded.args[1].feeAmount).toBe(3n);
            if (prepared === update)
                expect(ready.preview().creditOutputs![0]!.availableCredit).toBe(110n);
            if (prepared === clear)
                expect(ready.preview().creditOutputs![0]).toMatchObject({
                    availableCredit: 0n,
                    unlimited: true,
                });
            if (prepared === finite)
                expect(ready.preview().creditOutputs![0]).toMatchObject({
                    availableCredit: 15n,
                    unlimited: false,
                });
            if (prepared.kind === "draw-credit") {
                expect(ready.getOutputs()[0]!.amount).toBe(27n);
                expect(decoded.args[1].totalAmount).toBe(30n);
            }
        }
    },
    600000
);

if (process.env.CI && process.env.INVISI_SKIP_INITIAL_PAYMENT_PROOFS === "1")
    throw Error("CI must run initial-payment proofs");
const initialPaymentNative =
    process.env.INVISI_SKIP_INITIAL_PAYMENT_PROOFS === "1" ? it.skip : real;
initialPaymentNative(
    "proves a net-pinned repriced SDK initial payment with only the owner signing",
    async () => {
        const h = await setup();
        const prepared = await h.invisi.prepareCreateCredit({
            wallet: Wallet.fromAddress(h.wallet.getAddress()),
            protocol: h.protocol,
            tokenAddress: h.context.tokenAddress,
            spender: h.bob.getAddress(),
            expiry: 2000003600n,
            availableCredit: 20n,
            initialPayment: { amount: 7n, netAmount: 7n },
        });
        const prover =
            process.env.INVISI_TEST_WASM === "1"
                ? new (await import("@invisi-labs/prover/wasm")).WasmProver({
                      threads: 4,
                      resources: testResourceOptions,
                  })
                : new (await import("@invisi-labs/prover/native")).NativeProver({
                      bbBin: process.env.BB_BINARY_PATH!,
                      threads: 4,
                      resources: { offline: true },
                  });
        const { quoteClient } = await import("../../../../../test-support/broadcaster-fixture");
        const quoted = await quoteClient(h.context, () => 3n).quote(prepared, { maxFeeAmount: 3n });
        const ready = await (await externallyAuthorize(quoted)).prove(prover);
        if (process.env.BB_BINARY_PATH) {
            const { verifyProofBundle } = await import("@invisi-labs/prover/native");
            expect(
                await verifyProofBundle(ready.exportProof(), {
                    bbBin: process.env.BB_BINARY_PATH,
                    resources: { offline: true },
                })
            ).toBe(true);
        }
        expect(ready.getOutputs()[0]!.amount).toBe(7n);
        const tx = new Interface(invisiCoreAbi).parseTransaction(await ready.exportTransaction())!;
        expect(tx.args[1].hasInitialPayment).toBe(true);
        expect(tx.args[2]).toHaveLength(3);
        expect(tx.args[1].totalAmount).toBe(10n);
        expect(tx.args[1].feeAmount).toBe(3n);
        expect(ready.preview().creditOutputs?.[0]).toMatchObject({
            availableCredit: 10n,
            totalSpent: 10n,
            dailySpent: 10n,
            monthlySpent: 10n,
        });
    },
    600_000
);
