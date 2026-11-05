import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";

// Bob authorizes 10 in cash funding via EIP-712 and Alice submits; Bob receives 3 and Alice receives 7 token in change.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run");
}

// The SDK requires BB 6.0.0; check before connecting or approving, and adjust the path to your local installation.
// Resolve the project bin/bb relative to this example, independently of the working directory.
const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error(
        "Barretenberg 6.0.0 is required; install it and update bbBin first. No network connection or transaction has been made"
    );
}

const [alice, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    // 1. Connect to the configured chain and validate the deployment provided by Protocol RPC.
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const tokenAddress = settings.tokenAddress;
    const aliceSigner = new EthereumWallet(alice.privateKey, provider);
    // Bob handles his ERC20 approval and cash funding authorization; Alice handles proving and final submission.
    const bobFundingSigner = new EthereumWallet(bob.privateKey, provider);
    const token = new Contract(tokenAddress, erc20Abi, bobFundingSigner);
    const decimals = Number(await token.decimals());
    const aliceWallet = alice.publicWallet;
    const prover = new NativeProver({
        bbBin,
    });
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover,
    });

    // Public cash funding of 10 token requires a separate ERC20 allowance.
    const cashAmount = parseUnits("10", decimals);
    const allowance = await token.allowance(bob.address, protocol.context.protocolAddress);
    if (allowance < cashAmount) {
        // Support standard ERC20 tokens that require resetting an existing allowance to zero first.
        if (allowance > 0n) {
            const reset = await token.approve(protocol.context.protocolAddress, 0n);
            console.log("Allowance reset transaction:", reset.hash);
            await reset.wait();
        }
        const approval = await token.approve(protocol.context.protocolAddress, cashAmount);
        console.log("Approval transaction:", approval.hash);
        await approval.wait();
    }

    // Allow one hour for local proving; the SDK still checks on-chain time and state.
    const latestBlock = await provider.getBlock("latest");
    if (!latestBlock) {
        throw new Error("Unable to retrieve the latest on-chain block");
    }
    const deadline = BigInt(latestBlock.timestamp) + 3600n;

    // Build hidden-amount outputs with prepareTransfer rather than the transparent-amount prepareShield.
    const outputs = [
        await NoteOutput.create({
            chainId: protocol.context.chainId,
            protocolAddress: protocol.context.protocolAddress,
            tokenAddress,
            amount: parseUnits("3", decimals),
            recipient: { type: "invisi", address: bob.publicWallet.getAddress() },
        }),
    ];
    // From 10 cash minus 3 for Bob, the SDK automatically creates 7 token in change for Alice.
    const prepared = await invisi.prepareTransfer({
        wallet: aliceWallet,
        protocol,
        tokenAddress,
        inputs: [],
        outputs,
        deadline,
        funding: {
            payer: bob.address,
            amount: cashAmount,
            // signature: Bob authorizes the specified funding and Alice can submit; this neither replaces ERC20 approve nor constitutes ERC20 Permit.
            authorization: "signature",
        },
    });

    // Without existing notes, no private spending authorization is needed, but a hidden-amount transfer still requires a proof.
    const proved = await prepared.prove({
        onProgress: (event) => {
            console.log("Local proving phase:", event.phase);
        },
    });
    // Cash funding uses a separate request that can be sent to a remote signer; the SDK need not hold Bob's private key.
    const fundingRequest = await proved.exportFundingAuthorization();
    const fundingSignature = await bobFundingSigner.signTypedData(fundingRequest.domain, fundingRequest.types, fundingRequest.message);
    const ready = await proved.withFundingSignature(fundingSignature);
    const call = await ready.exportTransaction();

    // Alice submits the transaction with ethers and pays gas; transaction signing is separate from protocol authorization.
    const transaction = await aliceSigner.sendTransaction(call);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
        throw new Error("Transaction was not confirmed successfully");
    }
    console.log("Confirmed block:", receipt.blockNumber);
} catch (error) {
    if (error instanceof InvisiError) {
        console.error("SDK preparation failed:", error.code);
        console.error("Reason:", error.message);
        if (error.outputIndex !== undefined) {
            console.error("Recipient with error (number", error.outputIndex + 1, ")");
        }
        process.exitCode = 1;
    } else {
        throw error;
    }
} finally {
    provider.destroy();
}
