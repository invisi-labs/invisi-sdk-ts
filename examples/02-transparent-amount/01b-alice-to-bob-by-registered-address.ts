import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { Wallet } from "@invisi-labs/sdk";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, InvisiError, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Bob has registered his address and provides only a 0x address; Alice looks up the registration and sends 1 token.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run");
}

const accounts = getAccounts();
const [alice] = accounts;
const bobAddress = "0x057a50e0224131676dDD82e5cE02395680c0c1AC";
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    // 1. Connect ethers to the chain and connect and validate the Protocol through the SDK.
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const aliceSigner = new EthereumWallet(alice.privateKey, provider);

    // 2. Connect to the ERC20 token with ethers.
    const tokenAddress = settings.tokenAddress;
    const token = new Contract(tokenAddress, erc20Abi, aliceSigner);

    // 3. Set the transfer amount using the token decimals.
    const amount = parseUnits("1", Number(await token.decimals()));
    const total = amount;

    // 4. The payer approves the required amount.
    const allowance = await token.allowance(alice.address, protocol.context.protocolAddress);

    if (allowance < total) {
        // Support ERC20 tokens that require resetting an existing allowance to zero first.
        if (allowance > 0n) {
            const reset = await token.approve(protocol.context.protocolAddress, 0n);
            console.log("Allowance reset transaction:", reset.hash);
            await reset.wait();
        }

        const approval = await token.approve(protocol.context.protocolAddress, total);
        console.log("Approval transaction:", approval.hash);
        await approval.wait();
    }

    // 5. The SDK builds transparent-amount funding; ethers handles subsequent on-chain submission.
    // Bob provides only a 0x address; the SDK looks up its registered public key during prepareShield.
    // A full 0i address contains receiving public keys and requires no registration; Bob's private key is not read here.
    const outputs = [
        await NoteOutput.create({
            chainId: protocol.context.chainId,
            protocolAddress: protocol.context.protocolAddress,
            tokenAddress,
            amount: amount,
            // envelope defaults to true; addressLookup defaults to protocol-rpc.
            // Registration must be confirmed and indexed before preparation.
            recipient: { type: "evm", address: bobAddress },
        }),
    ];

    const aliceWallet = Wallet.fromAddress(alice.receivingAddress);
    const invisi = new Invisi({
        provider,
        protocolRpc,
    });
    const prepared = await invisi.prepareShield({
        wallet: aliceWallet,
        protocol,
        tokenAddress,
        outputs,
        funding: {
            payer: alice.address,
            amount: total,
            // caller: the payer and on-chain submitter must match; both are Alice here.
            // The contract checks payer === msg.sender; no separate EIP-712 funding signature is needed.
            // Encode with ready(), then have Alice sign and submit the on-chain transaction with ethers.
            // This mode still requires sufficient ERC20 allowance and does not replace approve.
            authorization: "caller",
        },
    });

    // Alice funds the transfer herself, so call ready directly; transparent-amount shield requires no proof.
    const ready = await prepared.ready();
    const call = await ready.exportTransaction();

    // 6. Alice submits the transaction with ethers and pays gas.
    const transaction = await aliceSigner.sendTransaction(call);
    console.log("Privacy transfer transaction:", transaction.hash);

    const receipt = await transaction.wait();
    console.log("Confirmed block:", receipt?.blockNumber);
} catch (error) {
    if (error instanceof InvisiError) {
        console.error("SDK preparation failed, error code:", error.code);
        if (error.code === "EVM_ADDRESS_NOT_REGISTERED") {
            console.error("No registered receiving public key was found for this 0x address:", error.address);
            console.error("Register the address first, or ask the recipient for their full 0i address.");
        } else if (error.code === "RECIPIENT_LOOKUP_FAILED") {
            console.error("Receiving public key lookup failed; registration status is currently unknown:", error.address);
        } else if (error.code === "INVALID_RECIPIENT") {
            console.error("Invalid receiving address format:", error.address);
        } else {
            console.error("Reason:", error.message);
        }

        if (error.outputIndex !== undefined) {
            // SDK indices are zero-based; the console displays the one-based recipient number.
            console.error("Recipient with error (number", error.outputIndex + 1, ")");
        }
        process.exitCode = 1;
    } else {
        throw error;
    }
} finally {
    provider.destroy();
}
