import { getAddress } from "ethers";
import type { CreditInput, NoteInput } from "./explicit-types";
import { PreparedTransaction } from "./PreparedTransaction";
import { positiveAmount } from "./session/prepare-common";
import { TransactionPreparation } from "./session/transaction-preparation";
import type { PreparationInventory, WalletSessionOptions } from "./session/operation-types";

/** Only explicitly supplied records participate. No store or automatic coin selection. */
export function explicitPreparation(
    options: WalletSessionOptions,
    data: {
        inputs?: readonly NoteInput[];
        creditInputs?: readonly CreditInput[];
        changeAddress?: string;
    },
    tokenAddress: `0x${string}`
) {
    if (!options.chainReader) throw new Error("chain reader required");
    const inputs = structuredClone(data.inputs ?? []);
    const credits = structuredClone(data.creditInputs ?? []);
    const inventory: PreparationInventory = { notes: {}, credits: {}, reservations: {} };
    const context = options.protocol.context;
    function position(input: NoteInput | CreditInput) {
        if (
            typeof input.treeId !== "bigint" ||
            input.treeId < 0n ||
            input.treeId >= 1n << 256n ||
            !Number.isInteger(input.leafIndex) ||
            input.leafIndex < 0 ||
            input.leafIndex >= 65536
        )
            throw new Error("invalid explicit input position");
    }
    for (const input of inputs) {
        position(input);
        positiveAmount(input.note.amount);
        if (inventory.notes[input.commitment]) throw new Error("duplicate explicit note input");
        if (
            input.note.chainId !== context.chainId ||
            input.note.protocolAddress !== BigInt(context.protocolAddress) ||
            input.note.walletIdentity !== options.wallet.walletIdentity
        )
            throw new Error("explicit note identity or deployment mismatch");
        inventory.notes[input.commitment] = { ...input, spent: "unspent" };
    }
    for (const input of credits) {
        position(input);
        if (input.role !== "owner" && input.role !== "spender")
            throw new Error("invalid explicit Credit role");
        const key = input.commitment + ":" + input.role;
        if (inventory.credits[key]) throw new Error("duplicate explicit Credit input");
        inventory.credits[key] = { ...input, spent: "unspent" };
    }
    const scope = {
        ...context,
        namespace: "explicit",
        walletIdentity: options.wallet.walletIdentity,
    };
    const {
        store: _store,
        coinSelector: _selector,
        authorization: _authorization,
        viewing: _viewing,
        signer: _signer,
        fundingSigner: _fundingSigner,
        ...capabilities
    } = options;

    if (inputs.some((input) => input.note.tokenAddress !== BigInt(getAddress(tokenAddress))))
        throw new Error("explicit note token mismatch");
    const runtime = {
        options: { ...capabilities, protocol: options.protocol.forToken(tokenAddress) },
        reader: options.chainReader!,
        scope,
    };
    return new TransactionPreparation<PreparedTransaction>({
        ...runtime,
        explicitInputs: true,
        ...(data.changeAddress ? { changeAddress: data.changeAddress } : {}),
        readInventory: async () => structuredClone(inventory),
        complete: async (plan) => PreparedTransaction.prepare(runtime, plan),
    });
}
