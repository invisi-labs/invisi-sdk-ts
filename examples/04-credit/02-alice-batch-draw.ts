import { settings } from "../settings.js";
import { randomInt } from "node:crypto";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits, formatUnits, getBytes } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient, ViewingCapability, creditPeriods, type CreditInput } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";
import { discoverCredits } from "./discover-credits.js";

// Alice draws on credit from two distinct owners, Bob and Charlie, in a combined payment to Alice note bound address.
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

    const signer = new EthereumWallet(alice.privateKey, provider);
    const token = new Contract(tokenAddress, erc20Abi, provider);
    const decimals = Number(await token.decimals());
    const viewer = new ViewingCapability(alice.address, getBytes(alice.viewingPrivateKey), alice.publicWallet.viewingPublicKey);
    // Discover all unspent credit without filtering by amount, owner, or expiry, or depending on a specific preceding example.
    const candidates = await discoverCredits({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        viewer,
        tokenAddress,
        role: "spender",
    });
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const deadline = timestamp + 3600n;

    // 1. Estimate the remaining daily and monthly allowances using the local UTC date; a zero limit does not mean a zero balance.
    // Zero disables the corresponding limit; SDK preparation still independently checks all allowances and expiry rules.
    const periods = creditPeriods(timestamp);
    const available: { input: CreditInput; amount: bigint }[] = [];
    for (const input of candidates) {
        const note = input.state.note;
        if (
            note.amount < 2n ||
            note.expiry <= deadline ||
            BigInt(note.spenderWalletIdentity) !== BigInt(alice.address) ||
            note.spenderPayout !== BigInt(alice.address)
        ) {
            continue;
        }
        // Use at most half of each note and no more than 10 token, preserving a balance for later top-up and cancellation.
        // All three independent limits apply, and the amount must be at least two base units.
        let amount = note.amount / 2n;
        const maximum = parseUnits("10", decimals);
        if (amount > maximum) {
            amount = maximum;
        }
        const singleLimit = note.singleLimit ?? 0n;
        if (singleLimit > 0n && amount > singleLimit) {
            amount = singleLimit;
        }
        for (const [limit, previousPeriod, spent, currentPeriod] of [
            [note.dailyLimit ?? 0n, note.lastDay ?? 0n, note.dailySpent ?? 0n, periods.currentDay],
            [note.monthlyLimit ?? 0n, note.lastMonth ?? 0n, note.monthlySpent ?? 0n, periods.currentMonth],
        ]) {
            if (previousPeriod > currentPeriod) {
                amount = 0n;
                break;
            }
            if (limit === 0n) {
                continue;
            }
            const remaining = limit - (previousPeriod === currentPeriod ? spent : 0n);
            if (amount > remaining) {
                amount = remaining;
            }
        }
        if (amount > 0n) {
            available.push({ input, amount });
        }
    }

    // 2. Require one note each from Bob and Charlie; do not fall back to a single note or a batch from the same owner.
    const bobCredits = available.filter((item) => {
        return BigInt(item.input.state.note.ownerWalletIdentity) === BigInt(bob.address);
    });
    const charlieCredits = available.filter((item) => {
        return BigInt(item.input.state.note.ownerWalletIdentity) === BigInt(charlie.address);
    });
    if (bobCredits.length === 0 || charlieCredits.length === 0) {
        throw new Error("Alice must have one valid credit note with available allowance from each of Bob and Charlie");
    }
    const selected = [bobCredits[randomInt(bobCredits.length)]!, charlieCredits[randomInt(charlieCredits.length)]!];
    const creditInputs = selected.map((item) => item.input);
    const credits = selected.map((item) => ({
        credit: item.input.commitment,
        amount: item.amount,
    }));
    const totalAmount = selected.reduce((total, item) => total + item.amount, 0n);
    for (const item of selected) {
        console.log("Selected owner:", item.input.state.note.ownerWalletIdentity);
        console.log("Amount drawn (token):", formatUnits(item.amount, decimals));
    }

    // 3. One call may use different owners, but the spender and bound public recipient address must match.
    // Pay funds directly to Alice note bound 0x address; each remaining balance becomes a separate new credit note.
    const prepared = await invisi.prepareDrawCredit({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        creditInputs,
        credits,
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
    console.log("Public recipient address:", alice.address);
    console.log("Total payment (token):", formatUnits(totalAmount, decimals));
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
