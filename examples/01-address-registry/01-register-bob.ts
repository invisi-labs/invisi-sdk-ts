import { settings } from "../settings.js";
import { Wallet } from "@invisi-labs/sdk";
import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";
import { Invisi, InvisiError, ProtocolRpcClient } from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Bob signs protocol authorization, submits his address registration, and pays gas himself.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run");
}

const [, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    // 1. Connect to the configured chain; the SDK obtains its registry deployment from Protocol RPC.
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);

    // 2. Build a public wallet from an existing full 0i address and configure connections centrally in Invisi.
    const bobWallet = Wallet.fromAddress(bob.receivingAddress);
    const bobSigner = new EthereumWallet(bob.privateKey, provider);
    const invisi = new Invisi({
        provider,
        protocolRpc,
    });

    // 3. The SDK builds a registration request and reads the registration nonce; Bob signs the EIP-712 authorization.
    // The SDK discovers and validates the registry contract; initial registration defaults to update: false and existing registrations prompt an update instead.
    const prepared = await invisi.prepareRegistration({
        wallet: bobWallet,
    });
    const request = await prepared.exportRegistrationAuthorization();

    // Bob can sign the request on another device and return only the signature, keeping his private key private.
    const signature = await bobSigner.signTypedData(request.domain, request.types, request.message);
    const ready = await prepared.withSignature(signature);
    const call = await ready.exportTransaction();

    // 4. Submit the registration transaction with ethers; the SDK does not broadcast on the user's behalf.
    const transaction = await bobSigner.sendTransaction(call);
    console.log("Bob address registration transaction:", transaction.hash);

    const receipt = await transaction.wait();
    console.log("Confirmed block:", receipt?.blockNumber);
    console.log("Bob EVM address:", bob.address);
    console.log("Bob privacy receiving address:", bob.receivingAddress);
} catch (error) {
    if (error instanceof InvisiError) {
        // A prepareRegistration failure reaches here and skips subsequent signing and transaction submission.
        console.error("Address registration preparation failed, error code:", error.code);
        console.error("Reason:", error.message);
        console.error("This example only performs initial registration; if Bob is registered, use 02-update-bob.ts to update it.");
        process.exitCode = 1;
    } else {
        throw error;
    }
} finally {
    provider.destroy();
}
