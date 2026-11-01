import { settings } from "../settings.js";
import { setTimeout } from "node:timers/promises";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, getBytes, parseUnits } from "ethers";
import { erc20Abi } from "viem";
import {
    fundsV1,
    Invisi,
    InvisiError,
    Protocol,
    ProtocolRpcClient,
    ViewingCapability,
    decodeMemoText,
    type PaymentOutput,
} from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Alice transfers a public amount of 1 token to Bob, demonstrating the standard v1 payload.
if (!process.argv.includes("--execute")) {
    throw new Error("Review the code, then add --execute to run");
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
    const aliceWallet = alice.publicWallet;
    const invisi = new Invisi({
        provider,
        protocolRpc,
    });

    // 2. Alice pays 1 token in public cash, creating a single output for Bob.
    const token = new Contract(tokenAddress, erc20Abi, aliceSigner);
    const amount = parseUnits("1", Number(await token.decimals()));
    const allowance = await token.allowance(alice.address, protocol.context.protocolAddress);
    if (allowance < amount) {
        // Support ERC20 tokens that require resetting an existing allowance to zero first.
        if (allowance > 0n) {
            const reset = await token.approve(protocol.context.protocolAddress, 0n);
            console.log("Allowance reset transaction:", reset.hash);
            await reset.wait();
        }
        const approval = await token.approve(protocol.context.protocolAddress, amount);
        console.log("Approval transaction:", approval.hash);
        await approval.wait();
    }

    // 3. The memo is encrypted with the received note; on-chain calldata contains only ciphertext, with no plaintext memo.
    // The SDK supports UTF-8 strings or Uint8Array up to 256 bytes; multibyte characters count by their UTF-8 byte length.
    const memo = "Order INVISI-TEST-001: payment receipt memo";
    // payload accepts Uint8Array; fundsV1 only wraps memo, contains no flags or refund address, and does not determine the envelope version.
    // For custom data, encode your own format directly, such as application version 1 plus JSON:
    // const json = new TextEncoder().encode(JSON.stringify({ orderId: 'INVISI-TEST-001' }));
    // const customPayload = new Uint8Array([1, ...json]);
    // Replace payload below with customPayload and decode using the same convention at the recipient; no codec injection into Invisi is needed.
    const outputs: PaymentOutput[] = [
        {
            to: bob.publicWallet.getAddress(),
            amount,
            payload: fundsV1.encode({
                memo,
            }),
        },
    ];
    // 4. caller means Alice funds and submits herself; no extra funding signature or proof is required.
    const prepared = await invisi.prepareShield({
        wallet: aliceWallet,
        protocol,
        tokenAddress,
        outputs,
        funding: {
            payer: alice.address,
            amount,
            authorization: "caller",
        },
    });
    const ready = await prepared.ready();
    const call = await ready.exportTransaction();

    // Alice submits the transaction with ethers and pays gas; transaction signing is separate from protocol authorization.
    const transaction = await aliceSigner.sendTransaction(call);
    console.log("Transaction hash:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
        throw new Error("Transaction was not confirmed successfully");
    }
    console.log("Confirmed block:", receipt.blockNumber);

    // 5. Bob reads the memo using only his viewing key, without using his EVM private key or sending the viewing key to RPC.
    const bobViewer = new ViewingCapability(bob.address, getBytes(bob.viewingPrivateKey), bob.publicWallet.viewingPublicKey);
    const rpc = protocolRpc.withProvider(provider);
    // Wait for this new transaction to be indexed; a timeout stops reading without resending the successful transaction.
    const indexDeadline = Date.now() + 120_000;
    let status = await rpc.getStatus(protocol.context);
    while (!status.indexedHead || status.indexedHead.number < BigInt(receipt.blockNumber)) {
        if (Date.now() >= indexDeadline) {
            throw new Error("The transaction succeeded, but RPC indexing and memo reading timed out; do not pay again");
        }
        await setTimeout(2_000);
        status = await rpc.getStatus(protocol.context);
    }
    // Query ciphertext outputs only in this transaction's block, without retrieving historical receipts or creating a Store or Session.
    const page = await rpc.getOutputs(protocol.context, {
        fromBlock: BigInt(receipt.blockNumber),
        toBlock: BigInt(receipt.blockNumber),
    });
    const output = page.outputs.find(
        (item) =>
            item.transactionHash.toLowerCase() === transaction.hash.toLowerCase() && BigInt(item.tokenAddress) === BigInt(tokenAddress)
    );
    if (!output) {
        throw new Error("RPC did not return the note received by Bob");
    }
    // The SDK restores notes according to the envelope version and returns payload unchanged; the application explicitly decodes the built-in format.
    const note = await bobViewer.decryptNote(output.ciphertext, {
        chainId: protocol.context.chainId,
        protocolAddress: BigInt(protocol.context.protocolAddress),
        tokenAddress: BigInt(tokenAddress),
        outputCommitment: output.commitment,
    });
    // Use fundsV1.decode here only when the sender used fundsV1.encode.
    // If using the custom bytes above, check the application version before parsing as JSON:
    // if (note.payload.length < 1 || note.payload[0] !== 1) {
    //     throw new Error('Unsupported application version');
    // }
    // const customData: unknown = JSON.parse(
    //     new TextDecoder('utf-8', { fatal: true }).decode(note.payload.subarray(1)),
    // );
    // The application should also validate customData structure, order identifiers, and other fields; the SDK does not interpret them.
    const data = fundsV1.decode(note.payload);
    if (!data.memo) {
        throw new Error("The note received by Bob has no memo");
    }
    const receivedMemo = decodeMemoText(data.memo);
    if (receivedMemo !== memo) {
        throw new Error("The memo decrypted by Bob does not match the sent content");
    }
    // This output is read locally by Bob; RPC and on-chain observers see only the encrypted memo.
    console.log("Memo decrypted by Bob:", receivedMemo);
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
