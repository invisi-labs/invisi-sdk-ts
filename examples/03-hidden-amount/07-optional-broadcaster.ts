import { settings } from "../settings.js";
import { discoverCandidates } from "./discover-candidates.js";
import { getAccounts } from "../accounts.js";
import { JsonRpcProvider, Wallet as EthereumWallet, getBytes } from "ethers";
import { BroadcasterClient, Invisi, Protocol, ProtocolRpcClient, ViewingCapability } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";

// Spend an existing private note. --self-send uses ordinary ethers with no public fee.
// The default paid route exports wallet authorization and sends only final public calldata to HTTPS.
if (!process.argv.includes("--execute")) throw new Error("Review the code, then add --execute to run");
const selfSend = process.argv.includes("--self-send");
if (!selfSend && BigInt(settings.broadcasterSigner) === 0n)
    throw new Error("Configure a trusted broadcaster URL and quote signer in settings.ts first");
if (!(await checkBBAvailable(settings.bbBin))) throw new Error("Barretenberg 6.0.0 is required");
const [alice, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) throw new Error("Connected chain does not match settings.chainId");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const invisi = new Invisi({ provider, protocolRpc, prover: new NativeProver({ bbBin: settings.bbBin }) });
    const viewer = new ViewingCapability(alice.address, getBytes(alice.viewingPrivateKey), alice.publicWallet.viewingPublicKey);
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        viewer,
        tokenAddress: settings.tokenAddress,
    });
    const input = candidates.find((candidate) => candidate.note.amount > settings.broadcasterMaxFeeAmount * 2n);
    if (!input) throw new Error("Fund Alice with a private note large enough for the payment and configured fee limit");
    const block = await provider.getBlock("latest");
    if (!block) throw new Error("Latest block unavailable");
    const options = {
        wallet: alice.publicWallet,
        protocol,
        tokenAddress: settings.tokenAddress,
        inputs: [input],
        outputs: [{ to: bob.receivingAddress, amount: input.note.amount / 2n }],
        deadline: BigInt(block.timestamp) + 3600n,
    };
    const client = new BroadcasterClient(settings.broadcasterUrl, {
        chainId: settings.chainId,
        protocol: protocol.context.protocolAddress,
        signer: settings.broadcasterSigner,
    });
    // Fee preparation is bounded and completes before authorization; changed fees select notes/change again.
    // The fee endpoint is a preliminary fixed price. The later signed quote binds the complete final intent.
    const prepared = selfSend
        ? await invisi.prepareTransfer(options)
        : await invisi.prepareTransferWithFee(
              options,
              async () => {
                  const fee = await client.fee(settings.tokenAddress);
                  return { recipient: fee.feeRecipient as `0x${string}`, amount: BigInt(fee.feeAmount) };
              },
              { maxFeeAmount: settings.broadcasterMaxFeeAmount, maxAttempts: 4 }
          );
    console.log("Public token fee (base units):", prepared.preview().feeAmount.toString());
    const quote = selfSend ? undefined : await client.quote((await prepared.exportBroadcasterIntent()).data);
    // Send this public EIP-712 request to the user's signing device. Never send input notes or witnesses.
    const request = await prepared.exportWalletAuthorization();
    const ownerSigner = new EthereumWallet(alice.privateKey, provider);
    const signature = await ownerSigner.signTypedData(request.domain, request.types, request.message);
    const ready = await (await prepared.withWalletSignature(signature)).prove();
    const call = await ready.exportTransaction();
    if (selfSend) {
        const transaction = await ownerSigner.sendTransaction(call);
        const receipt = await transaction.wait();
        console.log("Self-submitted transaction:", transaction.hash, "block:", receipt?.blockNumber);
    } else {
        if (!quote) throw new Error("Firm quote unavailable");
        // The client verifies chain, Protocol, signer, deadline, fee and final request hash.
        const status = await client.submit(call.data, quote, crypto.randomUUID());
        console.log("Broadcaster request:", status.id, "status:", status.state, "transaction:", status.transactionHash);
        // Persist this id/key in your application and query client.status(id) on retries.
        // Verify transaction receipts and protocol state independently through your trusted chain RPC.
    }
} finally {
    provider.destroy();
}
