import { randomInt } from "node:crypto";
import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
import { discoverCandidates } from "./discover-candidates.js";

// Alice samples two notes: half goes publicly to Bob and one quarter privately to Charlie.
// The remainder becomes Alice's change; this arbitrary spend requires her authorization.
if (!process.argv.includes("--execute")) {
    console.log("Review this scenario, then pass --execute");
    process.exit(0);
}

const accounts = getAccounts();
const alice = accounts[0];
const bob = accounts[1];
const charlie = accounts[2];
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw Error("Configured chain mismatch");
    }

    // 1. Validate the chain and trusted deployment before constructing this intent.
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });

    // 2. Discover all eligible notes first; selection stays explicit and local to this scenario.
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        nativeWallet,
        tokenAddress,
    });
    const eligible = candidates.filter((input) => input.note.amount >= 4n);
    if (eligible.length < 2) {
        throw Error("Fewer than two eligible notes found; fund Alice and wait for indexing first");
    }
    const inputs = [
        eligible.splice(randomInt(eligible.length), 1)[0]!,
        eligible.splice(randomInt(eligible.length), 1)[0]!,
    ];
    const inputAmount = inputs.reduce((total, input) => total + input.note.amount, 0n);
    if (inputAmount < 2n) {
        throw Error("No eligible notes found; fund Alice and wait for indexing first");
    }
    const outputs = [
        await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: inputAmount / 4n,
            recipient: { type: "invisi", address: charlie.receivingAddress },
        }),
    ];

    // Native approval and local proving may take time; on-chain time still bounds validity.
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock) {
        throw Error("Missing latest block");
    }
    const deadline = BigInt(latestBlock.timestamp) + 3600n;

    // 3. Freeze the financial intent; preparation rechecks membership and current spent state.
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        deadline,
        inputs,
        outputs,
        withdrawal: { to: bob.address, amount: inputAmount / 2n },
    });

    // 4. Match the host response by ID and validate it against the retained statement.
    const request = await prepared.exportWalletRequest(crypto.randomUUID());
    const responses = await nativeWallet.execute([request]);
    const response = responses.find((item) => item.id === request.id);
    if (!response) {
        throw Error("Missing wallet response");
    }
    const authorized = await prepared.withWalletResponse(response);
    const ready = await authorized.prove();
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
