import { NoteOutput } from "@invisi-labs/sdk";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";

// Complete broadcaster walkthrough: Alice funds Bob's note and the fee; the broadcaster pays gas.
// The same withBroadcaster() attachment supports prepareTransfer, prepareShield,
// prepareCreateCredit, prepareTopUpCredit and prepareCancelCredit.
// Credit draw and address registration do not support broadcasters.
// Transfer and Credit operations also require owner authorization and a local proof;
// their public funding, when present, is signed after proving. Cancellation fees
// come from the refund; sufficient private change pays fees before extra public funding.
// Shield requires a funding signature, but no private-note authorization or ZK proof.
if (!process.argv.includes("--execute")) throw new Error("Review the code, then add --execute to run");

const [alice, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    // 1. Resolve and validate the deployment. Signing stays outside Invisi.
    if ((await provider.getNetwork()).chainId !== settings.chainId) throw new Error("Connected chain does not match settings.chainId");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const invisi = new Invisi({ provider, protocolRpc });
    const payerSigner = new EthereumWallet(alice.privateKey, provider);
    const token = new Contract(settings.tokenAddress, erc20Abi, payerSigner);
    const businessAmount = parseUnits("3", Number(await token.decimals()));
    const latest = await provider.getBlock("latest");
    if (!latest) throw new Error("Latest block unavailable");

    // 2. Describe intent: Bob receives exactly 3 tokens. No fee is decided here.
    const prepared = await invisi.prepareShield({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress: settings.tokenAddress,
        outputs: [
            await NoteOutput.create({
                chainId: protocol.context.chainId,
                protocolAddress: protocol.context.protocolAddress,
                tokenAddress: settings.tokenAddress,
                amount: businessAmount,
                recipient: { type: "invisi", address: bob.receivingAddress },
            }),
        ],
        funding: { payer: alice.address, amount: businessAmount, authorization: "signature" },
        deadline: BigInt(latest.timestamp) + 3600n,
    });

    // 3. Settle the fee and verify the final quote before requesting Alice's signature.
    // The returned object is another PreparedTransaction; the original intent stays unchanged.
    const clients = await protocol.getBroadcasters({ tokenAddress: settings.tokenAddress });
    // To compare services, call prepared.withBroadcaster(client, { maxFeeAmount }) for each client.
    // Compare the returned quoted.preview().feeAmount values, then continue signing and proving
    // with the lowest-fee quoted handle. This Shield example requires no proof.
    const client = clients[0];
    if (!client) throw new Error("No broadcaster supports this token");
    const quoted = await prepared.withBroadcaster(client, { maxFeeAmount: settings.broadcasterMaxFeeAmount });
    // Both handles expose inputDetails, outputs, creditOutputs and funding summaries.
    // The quoted summary includes the fee-adjusted funding amount and authorization mode.
    const { feeAmount } = quoted.preview();
    console.log("Broadcaster fee (base units):", feeAmount.toString());

    // 4. ERC20 allowance must cover the final amount, including the fee.
    // This ordinary approval is separate from the funding signature and may itself require gas.
    const fundingAmount = quoted.preview().funding.amount;
    const allowance: bigint = await token.allowance(alice.address, protocol.context.protocolAddress);
    if (allowance < fundingAmount) {
        if (allowance > 0n) await (await token.approve(protocol.context.protocolAddress, 0n)).wait();
        await (await token.approve(protocol.context.protocolAddress, fundingAmount)).wait();
    }

    // 5. Alice signs the exact final request on her own device; no private key reaches the service.
    const request = await quoted.exportFundingAuthorization();
    const signature = await payerSigner.signTypedData(request.domain, request.types, request.message);
    const ready = await quoted.withFundingSignature(signature);

    // 6. Export final calldata and submit with the retained verified quote. Shield has no prove() step.
    const call = await ready.exportTransaction();
    const quote = ready.broadcasterQuote();
    if (!quote) throw new Error("Verified broadcaster quote unavailable");
    const requestId = crypto.randomUUID();
    console.log("Broadcaster request ID (retain for retries):", requestId);
    // Applications must persist this ID before sending. Never replace it after a timeout.
    const status = await client.submit(call.data, quote, requestId);
    console.log("Submission:", status.state, "transaction:", status.transactionHash);
    // Recover with client.status(requestId); verify receipts and protocol state independently.
} finally {
    provider.destroy();
}
