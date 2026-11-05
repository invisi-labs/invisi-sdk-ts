import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { PublicWallet } from "@invisi-labs/sdk";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Bob funds 9 token and signs protocol authorization; Alice submits and the other nine participants each receive 1 token.
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
    const bobSigner = new EthereumWallet(bob.privateKey, provider);

    // 2. Read ERC20 decimals with ethers; the payer approves the required amount.
    const tokenAddress = settings.tokenAddress;
    const token = new Contract(tokenAddress, erc20Abi, bobSigner);
    const amount = parseUnits("1", Number(await token.decimals()));
    const total = amount * 9n;
    const allowance = await token.allowance(bob.address, protocol.context.protocolAddress);

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

    // 3. Use each recipient's provided 0i privacy address and send 1 token to each.
    const outputs = await Promise.all(
        accounts.slice(1).map(
            async (recipient) =>
                await NoteOutput.create({
                    chainId: protocol.context.chainId,
                    protocolAddress: protocol.context.protocolAddress,
                    tokenAddress,
                    amount: amount,
                    recipient: { type: "invisi", address: recipient.receivingAddress },
                })
        )
    );

    // 4. First build only the funding request, without injecting any signer into Invisi.
    // aliceWallet contains only public receiving information, with no Alice private key, and does not sign.
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
            payer: bob.address,
            amount: total,
            // signature: payer and submitter may differ; Bob funds and Alice submits here.
            // Bob must separately sign EIP-712 funding authorization for the SDK-exported request.
            // After the SDK validates the signature, Alice signs and submits the on-chain transaction and pays gas.
            // Authorization binds this request, amount, nonce, and deadline; submission is not restricted to Alice.
            // This signature still requires sufficient ERC20 allowance and does not replace Bob's approve.
            authorization: "signature",
        },
    });

    // 5. Alice exports the signing request to Bob's device; request can be serialized directly as JSON for transport.
    const request = await prepared.exportFundingAuthorization();

    // 6. Bob signs EIP-712 data on his own device without sharing his private key with Alice.
    // This demonstration uses a local ethers signer; it can be replaced with a hardware wallet, MPC, or remote signer.
    const signature = await bobSigner.signTypedData(request.domain, request.types, request.message);

    // 7. Alice passes the received signature to the SDK for validation; the SDK binds it to the original funding request.
    const ready = await prepared.withFundingSignature(signature);
    const call = await ready.exportTransaction();

    // 8. Alice: receive the call containing Bob's authorization and sign the on-chain transaction with her own wallet.
    // Alice only needs call, not Bob's private key; in practice these are two separate wallet signing steps.
    const transaction = await aliceSigner.sendTransaction(call);
    console.log("Privacy transfer transaction:", transaction.hash);

    const receipt = await transaction.wait();
    console.log("Confirmed block:", receipt?.blockNumber);
} finally {
    provider.destroy();
}
