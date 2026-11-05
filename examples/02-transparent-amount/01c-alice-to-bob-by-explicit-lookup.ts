import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { PublicWallet } from "@invisi-labs/sdk";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
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

    // 5. Select direct chain lookup for this recipient only.
    // Preparation validates the Protocol registry and reads its current receiving keys.
    // No custom resolver or lookup option belongs on the Invisi constructor.
    const outputs = [
        await NoteOutput.create({
            chainId: protocol.context.chainId,
            protocolAddress: protocol.context.protocolAddress,
            tokenAddress,
            amount: amount,
            recipient: { type: "evm", address: bobAddress, addressLookup: "chain" },
        }),
    ];

    const aliceWallet = PublicWallet.fromAddress(alice.receivingAddress);
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
} finally {
    provider.destroy();
}
