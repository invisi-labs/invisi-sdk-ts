import { settings } from "../settings.js";
import { randomInt } from "node:crypto";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits, getBytes, formatUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient, ViewingCapability } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

// Bob uses the full amount of one existing payment note and Charlie uses two to create credit for Alice; each signs a request and pays gas.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run it");
}

// Resolve the project's bin/bb relative to this example and check BB 6.0.0 before connecting to the network.
const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required; install the correct version at bin/bb in the project first");
}
const [alice, bob, charlie] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const prover = new NativeProver({ bbBin });
    const invisi = new Invisi({ provider, protocolRpc, prover });

    // 1. The two owners create credit separately in two independent transactions; creation is not atomic.
    // Rerunning this example after either transaction succeeds creates additional credit; there is no idempotency mechanism or file record.
    for (const owner of [bob, charlie]) {
        const ownerSigner = new EthereumWallet(owner.privateKey, provider);
        const token = new Contract(tokenAddress, erc20Abi, ownerSigner);
        const decimals = Number(await token.decimals());
        const viewer = new ViewingCapability(owner.address, getBytes(owner.viewingPrivateKey), owner.publicWallet.viewingPublicKey);
        const candidates = await discoverCandidates({
            provider,
            protocolRpc,
            protocol,
            wallet: owner.publicWallet,
            viewer,
            tokenAddress,
        });
        const inputCount = owner.address === charlie.address ? 2 : 1;
        if (candidates.length < inputCount) {
            throw new Error(`${owner.name} requires at least ${inputCount} unspent existing token payment notes`);
        }
        // Remove randomly selected candidates from the list so Charlie's two notes are distinct and the same note cannot be spent twice.
        const selected = [];
        for (let index = 0; index < inputCount; index++) {
            const [input] = candidates.splice(randomInt(candidates.length), 1);
            selected.push(input!);
        }
        const amount = selected.reduce((total, input) => total + input.note.amount, 0n);
        const timestamp = BigInt(Math.floor(Date.now() / 1000));

        // 2. The owner uses a public wallet and Alice is the spender; each party's payout address is bound to their own 0x address.
        const prepared = await invisi.prepareCreateCredit({
            wallet: owner.publicWallet,
            protocol,
            tokenAddress,
            inputs: selected,
            spender: alice.publicWallet.getAddress(),
            amount,
            singleLimit: parseUnits("20", decimals),
            dailyLimit: parseUnits("50", decimals),
            monthlyLimit: parseUnits("100", decimals),
            expiry: timestamp + 7n * 24n * 60n * 60n,
            deadline: timestamp + 3600n,
        });

        // 3. The current owner signs the request externally; no default SDK signer or Alice signature is needed.
        const request = await prepared.exportWalletAuthorization();
        const signature = await ownerSigner.signTypedData(request.domain, request.types, request.message);
        const authorized = await prepared.withWalletSignature(signature);
        const proved = await authorized.prove({
            onProgress: (event) => {
                console.log(owner.name, "Local proving phase:", event.phase);
            },
        });
        const call = await proved.exportTransaction();
        const transaction = await ownerSigner.sendTransaction(call);
        console.log(owner.name, "Credit creation transaction:", transaction.hash);
        const receipt = await transaction.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error("Credit creation was not confirmed successfully");
        }
        console.log(owner.name, "Confirmation block:", receipt.blockNumber);
        console.log("Credit spender Alice:", alice.address);
        console.log("Credit amount (token):", formatUnits(amount, decimals));
    }
} catch (error) {
    if (error instanceof InvisiError) {
        console.error("SDK preparation failed:", error.code);
        console.error("Reason:", error.message);
        process.exitCode = 1;
    } else {
        throw error;
    }
} finally {
    provider.destroy();
}
