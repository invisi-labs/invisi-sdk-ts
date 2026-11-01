import { settings } from "../settings.js";
import { randomInt } from "node:crypto";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits, formatUnits, getBytes } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient, ViewingCapability } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";
import { discoverCredits } from "./discover-credits.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

// Bob tops up credit with an existing payment note plus cash, returning the excess as change; extend expiry by 7 days and preserve existing usage.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run it");
}

// Resolve the project's bin/bb relative to this example and check BB 6.0.0 before connecting to the network.
const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required; install the correct version at bin/bb in the project first");
}
const [alice, bob] = getAccounts();
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

    const signer = new EthereumWallet(bob.privateKey, provider);
    const token = new Contract(tokenAddress, erc20Abi, signer);
    const decimals = Number(await token.decimals());
    const viewer = new ViewingCapability(bob.address, getBytes(bob.viewingPrivateKey), bob.publicWallet.viewingPublicKey);
    // Discover all unspent credit without filtering by amount, owner, or expiry, or depending on a specific preceding example.
    const candidates = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        viewer,
        tokenAddress,
        role: "owner",
    });
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const deadline = timestamp + 3600n;

    // 1. Select only unexpired credit from Bob to Alice; expired credit can only be cancelled, not topped up.
    const eligible = candidates.filter((input) => {
        return (
            BigInt(input.state.note.spenderWalletIdentity) === BigInt(alice.address) &&
            input.state.note.spenderPayout === BigInt(alice.address) &&
            input.state.note.ownerPayout === BigInt(bob.address) &&
            input.state.note.expiry > deadline
        );
    });
    if (eligible.length === 0) {
        throw new Error("No unexpired credit from Bob to Alice is available for top-up");
    }
    const selected = eligible[randomInt(eligible.length)]!;
    const paymentCandidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: bob.publicWallet,
        viewer,
        tokenAddress,
    });
    // At least two base units are needed to demonstrate both an existing note input and nonzero change.
    const eligiblePayments = paymentCandidates.filter((input) => input.note.amount >= 2n);
    if (eligiblePayments.length === 0) {
        throw new Error("Bob has no existing token payment note worth at least two base units");
    }
    const payment = eligiblePayments[randomInt(eligiblePayments.length)]!;
    const cashAmount = parseUnits("50", decimals);
    const noteContribution = payment.note.amount / 2n;
    const additionalAmount = noteContribution + cashAmount;
    const changeAmount = payment.note.amount - noteContribution;

    // 2. Approve only the cash portion; the same request from Bob authorizes spending both the existing payment note and existing credit.
    const allowance = await token.allowance(bob.address, protocol.context.protocolAddress);
    if (allowance < cashAmount) {
        if (allowance > 0n) {
            const reset = await token.approve(protocol.context.protocolAddress, 0n);
            console.log("Allowance reset transaction:", reset.hash);
            await reset.wait();
        }
        const approval = await token.approve(protocol.context.protocolAddress, cashAmount);
        console.log("Approval transaction:", approval.hash);
        await approval.wait();
    }
    // The top-up increases the amount without shortening validity; the new credit remains bound to the original owner/spender and historical public-key snapshot.
    // Changing limits does not reset existing usage; monthlyLimit: 0n disables the monthly limit instead of setting the monthly allowance to zero.
    const prepared = await invisi.prepareTopUpCredit({
        wallet: bob.publicWallet,
        protocol,
        tokenAddress,
        inputs: [payment],
        creditInputs: [selected],
        credit: selected.commitment,
        additionalAmount,
        expiry: selected.state.note.expiry + 7n * 24n * 60n * 60n,
        singleLimit: parseUnits("30", decimals),
        dailyLimit: parseUnits("60", decimals),
        monthlyLimit: 0n,
        deadline,
        funding: {
            payer: bob.address,
            amount: cashAmount,
            authorization: "caller",
        },
    });
    console.log("Amount before top-up (token):", formatUnits(selected.state.note.amount, decimals));
    // The SDK converts inputs exceeding additionalAmount into ordinary payment change, returning it to Bob by default.
    console.log("Existing payment note amount (token):", formatUnits(payment.note.amount, decimals));
    console.log("Cash added (token):", formatUnits(cashAmount, decimals));
    console.log("Top-up amount (token):", formatUnits(additionalAmount, decimals));
    console.log("Change returned to Bob (token):", formatUnits(changeAmount, decimals));
    console.log("Preserved daily usage (base units):", selected.state.note.dailySpent ?? 0n);
    console.log("Preserved monthly usage (base units):", selected.state.note.monthlySpent ?? 0n);

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
