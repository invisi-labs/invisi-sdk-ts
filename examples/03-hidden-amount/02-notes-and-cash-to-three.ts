import { randomInt } from "node:crypto";
import { JsonRpcProvider } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json, readHostJson, hostSignature } from "../host-transport.js";
import { discoverCandidates } from "./discover-candidates.js";

// Alice samples two notes; Bob adds matching cash through external EIP-712 funding.
// Alice, Bob, and Charlie receive the full total in three outputs, with no change.
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
    const eligible = candidates.filter((input) => input.note.amount >= 2n);
    if (eligible.length < 2) {
        throw Error("Fewer than two spendable notes found; fund Alice and wait for indexing first");
    }
    const inputs = [
        eligible.splice(randomInt(eligible.length), 1)[0]!,
        eligible.splice(randomInt(eligible.length), 1)[0]!,
    ];
    const inputAmount = inputs.reduce((sum, input) => sum + input.note.amount, 0n);
    const cashAmount = inputAmount;
    const totalAmount = inputAmount + cashAmount;
    const bobAmount = (totalAmount - 1n) / 2n;
    const recipients = [alice, bob, charlie];
    const outputs = await Promise.all(
        recipients.map((recipient, index) =>
            NoteOutput.create({
                ...protocol.context,
                tokenAddress,
                amount: [totalAmount - bobAmount - 1n, bobAmount, 1n][index]!,
                recipient: { type: "invisi", address: recipient.receivingAddress },
            })
        )
    );

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
        funding: { payer: bob.address, amount: cashAmount, authorization: "signature" },
    });

    // 4. Match the host response by ID and validate it against the retained statement.
    const request = await prepared.exportWalletRequest(crypto.randomUUID());
    const responses = await nativeWallet.execute([request]);
    const response = responses.find((item) => item.id === request.id);
    if (!response) {
        throw Error("Missing wallet response");
    }
    const authorized = await prepared.withWalletResponse(response);
    const proved = await authorized.prove();
    // Bob signs the finalized funding intent after Alice's private proof has been built.
    const fundingRequest = await proved.exportFundingAuthorization();
    const fundingId = crypto.randomUUID();
    console.log(
        "Host EVM typed-data requests:",
        json([{ id: fundingId, kind: "funding", ...fundingRequest }])
    );
    const ready = await proved.withFundingSignature(hostSignature(await readHostJson(), fundingId));
    // Export does not approve tokens or submit; the host reviews the required caller and gas.
    console.log("Unsigned transaction for host submission:", json(await ready.exportTransaction()));
} finally {
    provider.destroy();
}
