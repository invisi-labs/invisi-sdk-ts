import { settings } from "../settings.js";
import { discoverCandidates } from "./discover-candidates.js";
import { randomInt } from "node:crypto";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, getBytes } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient, ViewingCapability, type NoteInput } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";

// Alice randomly selects two existing notes; Bob authorizes matching cash via EIP-712, distributing the total to three recipients without change.
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

const [alice, bob, charlie] = getAccounts();
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
    // Bob handles his cash approval and funding request; Alice handles existing-note authorization and final submission.
    const bobFundingSigner = new EthereumWallet(bob.privateKey, provider);
    const token = new Contract(tokenAddress, erc20Abi, bobFundingSigner);
    const aliceWallet = alice.publicWallet;
    const prover = new NativeProver({
        bbBin,
    });
    // Use viewing capability only to recover Alice's notes; prepare spending with a public wallet and no default signer.
    const viewer = new ViewingCapability(alice.address, getBytes(alice.viewingPrivateKey), aliceWallet.viewingPublicKey);
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover,
    });

    // 2. Discover Alice's candidate notes; random selection and amount calculations are shown below.
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: aliceWallet,
        viewer,
        tokenAddress,
    });
    // Filter by the amounts required by this example; candidates retains all discovered results.
    const eligibleCandidates = candidates.filter((input) => input.note.amount >= 1n);
    if (eligibleCandidates.length < 2) {
        throw new Error("Insufficient available notes; fund Alice first. Notes need not come from a specific example");
    }
    // Sample uniformly without replacement, in memory only, without creating a Store or Session.
    const inputs: NoteInput[] = [];
    for (let index = 0; index < 2; index += 1) {
        const selectedIndex = randomInt(eligibleCandidates.length);
        inputs.push(eligibleCandidates.splice(selectedIndex, 1)[0]!);
    }
    const inputAmount = inputs.reduce((total, input) => total + input.note.amount, 0n);
    console.log("Number of real input notes:", inputs.length);
    console.log("Selected note total (base units):", inputAmount.toString());
    // RPC spent status is an indexed observation; prepare independently validates current membership paths and the latest on-chain spent status.

    // Bob adds cash equal to the total of both notes, requiring his own ERC20 allowance.
    const cashAmount = inputAmount;
    const totalAmount = inputAmount + cashAmount;
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

    // Charlie receives 1 base unit first; Alice and Bob split the remainder, with any integer remainder going to Alice.
    const bobAmount = (totalAmount - 1n) / 2n;
    // Build hidden-amount outputs with prepareTransfer rather than the transparent-amount prepareShield.
    const outputs = [
        {
            to: alice.publicWallet.getAddress(),
            amount: totalAmount - bobAmount - 1n,
        },
        {
            to: bob.publicWallet.getAddress(),
            amount: bobAmount,
        },
        {
            to: charlie.publicWallet.getAddress(),
            // 1n represents 1 base unit, not 1 whole token.
            amount: 1n,
        },
    ];
    // The three explicit outputs sum to totalAmount, producing no change.
    const prepared = await invisi.prepareTransfer({
        wallet: aliceWallet,
        protocol,
        tokenAddress,
        inputs,
        outputs,
        deadline,
        funding: {
            payer: bob.address,
            amount: cashAmount,
            // signature: Bob signs protocol funding authorization externally and Alice submits; this is separate from ERC20 approve.
            authorization: "signature",
        },
    });

    // Estimate main-transaction gas from its structure and benchmark data, without on-chain simulation or Bob's approval.
    // This is a reference gas-unit count, not a gas price or final fee.
    const { gasUnits } = prepared.estimateGas();
    console.log("Reference gas before proving:", gasUnits);

    // 4. Arbitrary spending of existing notes requires Alice's authorization; the signing tool receives only the SDK-exported request.
    // This authorizes private spending; it is separate from cash funding authorization and the EVM nonce used to submit the transaction.
    const walletRequest = await prepared.exportWalletAuthorization();
    const walletSignature = await aliceSigner.signTypedData(walletRequest.domain, walletRequest.types, walletRequest.message);
    const authorized = await prepared.withWalletSignature(walletSignature);

    // 5. After Alice authorizes her existing notes, generate the proof, then separately request Bob's cash funding signature.
    const proved = await authorized.prove({
        onProgress: (event) => {
            console.log("Local proving phase:", event.phase);
        },
    });
    const fundingRequest = await proved.exportFundingAuthorization();
    const fundingSignature = await bobFundingSigner.signTypedData(fundingRequest.domain, fundingRequest.types, fundingRequest.message);
    const ready = await proved.withFundingSignature(fundingSignature);
    const call = await ready.exportTransaction();

    // Once the full proof and signatures are ready, Alice, the actual submitter, estimates main-transaction gas with ethers.
    // Simulation sends no transaction; the estimate reflects current on-chain state and excludes the earlier ERC20 approval.
    const estimatedGas = await aliceSigner.estimateGas(call);
    console.log("Simulated gas before submission:", estimatedGas);

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
