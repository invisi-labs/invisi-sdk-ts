import { settings } from "../settings.js";
import { PublicWallet } from "@invisi-labs/sdk";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Alice sends Bob 1 token; the amount is public and the receipt becomes a private note.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run");
}

const accounts = getAccounts();
const [alice, bob] = accounts;
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    // 1. Connect ethers to the chain and connect and validate the Protocol through the SDK.
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }

    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const aliceSigner = new EthereumWallet(alice.privateKey, provider);

    // 2. Read ERC20 decimals with ethers; the payer approves the required amount.
    const tokenAddress = settings.tokenAddress;
    const token = new Contract(tokenAddress, erc20Abi, aliceSigner);
    const amount = parseUnits("1", Number(await token.decimals()));
    const total = amount;
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

    // 3. Use the 0i privacy receiving address provided by Bob; his private key is unnecessary.
    const outputs = [
        {
            to: bob.receivingAddress,
            amount,
        },
    ];

    // 4. The SDK builds transparent-amount funding; ethers handles subsequent on-chain submission.
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

    // 5. Alice submits the transaction with ethers and pays gas.
    const transaction = await aliceSigner.sendTransaction(call);
    console.log("Privacy transfer transaction:", transaction.hash);

    const receipt = await transaction.wait();
    console.log("Confirmed block:", receipt?.blockNumber);
} finally {
    provider.destroy();
}
