import { settings } from "../settings.js";
import { randomInt } from "node:crypto";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, formatUnits, getBytes } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient, ViewingCapability } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";
import { discoverCredits } from "./discover-credits.js";

// Charlie cancels the credit he granted Alice; remaining funds return to Charlie's bound address.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run it");
}

// Resolve the project's bin/bb relative to this example and check BB 6.0.0 before connecting to the network.
const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required; install the correct version at bin/bb in the project first");
}
const [alice, , charlie] = getAccounts();
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

    const signer = new EthereumWallet(charlie.privateKey, provider);
    const token = new Contract(tokenAddress, erc20Abi, provider);
    const decimals = Number(await token.decimals());
    const viewer = new ViewingCapability(charlie.address, getBytes(charlie.viewingPrivateKey), charlie.publicWallet.viewingPublicKey);
    // Discover all unspent credit without filtering by amount, owner, or expiry, or depending on a specific preceding example.
    const candidates = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: charlie.publicWallet,
        viewer,
        tokenAddress,
        role: "owner",
    });
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const deadline = timestamp + 3600n;

    // 1. Do not filter by expiry: Charlie can cancel his credit before or after it expires.
    const eligible = candidates.filter((input) => {
        return (
            BigInt(input.state.note.spenderWalletIdentity) === BigInt(alice.address) &&
            input.state.note.spenderPayout === BigInt(alice.address) &&
            input.state.note.ownerPayout === BigInt(charlie.address)
        );
    });
    if (eligible.length === 0) {
        throw new Error("No cancellable credit from Charlie to Alice is available");
    }
    const selected = eligible[randomInt(eligible.length)]!;
    console.log("Selected credit has expired:", selected.state.note.expiry <= timestamp);

    // 2. The remaining amount can return only to the credit's bound ownerPayout; it cannot be replaced with a third-party address.
    // Credit cancellation does not support the signature-free sweep rule for ordinary payment notes; Charlie must still sign the request.
    const prepared = await invisi.prepareCancelCredit({
        wallet: charlie.publicWallet,
        protocol,
        tokenAddress,
        creditInputs: [selected],
        credit: selected.commitment,
        deadline,
    });

    // Operations on existing credit always require the current role to sign the request; a viewing key alone cannot authorize a draw or cancellation.
    const request = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(request.domain, request.types, request.message);
    const authorized = await prepared.withWalletSignature(signature);
    const proved = await authorized.prove({
        onProgress: (event) => {
            console.log("Local proving phase:", event.phase);
        },
    });
    const call = await proved.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
        throw new Error("The transaction was not confirmed successfully");
    }
    console.log("Confirmation block:", receipt.blockNumber);
    console.log("Bound refund address:", charlie.address);
    console.log("Refund amount (token):", formatUnits(selected.state.note.amount, decimals));
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
