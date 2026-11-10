import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Wallet as EthersWallet, getBytes } from "ethers";
import {
    Invisi,
    Protocol,
    ProtocolRpcClient,
    BroadcasterClient,
    NoteOutput,
} from "@invisi-labs/sdk";
import {
    Provenance,
    ProvenanceClient,
    authenticateManifest,
    DEFAULT_PROVENANCE_ENDPOINT,
} from "@invisi-labs/sdk/provenance";
import type { TrustContext } from "@invisi-labs/sdk/provenance";
import { LocalProvenanceProver } from "@invisi-labs/prover/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

// Match these public trust pins to the deployment selected in ../settings.ts.
const provenanceEndpoint = DEFAULT_PROVENANCE_ENDPOINT;
const protocolAddress = "0x<20-byte-protocol-address>" as `0x${string}`;
const chainGeneration = "1";
const providerId = "0x<32-byte-provider-id>";
const signingKeyId = "0x<sha256-of-pinned-public-key>";
const signingPublicKey = "0x<32-byte-pinned-ed25519-public-key>";
const assetRoot = fileURLToPath(new URL("../../.cache/provenance/", import.meta.url));
const broadcasterEndpoint = "https://your-broadcaster.example/v1/chains/97";
const quoteSigner = "0x<registered-quote-signer>";
const feeRecipient = "0x<registered-fee-recipient>";

if (!process.argv.includes("--execute")) {
    console.log("Pass --execute to prepare, prove and broadcast. Review README first.");
    process.exit(0);
}
const pin = "cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a";
const trust: TrustContext = {
    chainId: settings.chainId,
    protocolAddress,
    chainGeneration,
    providerId,
    manifestSha256: pin,
    signingKeys: { [signingKeyId]: getBytes(signingPublicKey) },
};
const source = new ProvenanceClient(provenanceEndpoint, trust);
const manifest = await readFile(join(assetRoot, "manifest.json"));
const manifestIdentity = authenticateManifest(manifest, pin);
const sourceProver = new LocalProvenanceProver({
    trustedManifestSha256: pin,
    threads: 4,
    ...(process.env.INVISI_CRS_PATH ? { crsPath: process.env.INVISI_CRS_PATH } : {}),
    loadAssets: async (capacity) => {
        const entry = (
            JSON.parse(manifest.toString()).circuits as {
                capacity: number;
                artifact: string;
                vk: string;
            }[]
        ).find((entry) => entry.capacity === capacity)!;
        return {
            manifest,
            artifact: await readFile(join(assetRoot, entry.artifact)),
            verificationKey: await readFile(join(assetRoot, entry.vk)),
        };
    },
});

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId)
        throw Error("Primary chain mismatch");
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (protocol.context.protocolAddress.toLowerCase() !== protocolAddress.toLowerCase())
        throw Error("Pinned deployment mismatch");
    const [alice, bob] = getAccounts();
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase())
        throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
    const tokenAddress = settings.tokenAddress;
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });
    const inputs = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        nativeWallet,
        tokenAddress,
    });
    const selected = inputs.find(
        (input) => input.note.amount > settings.broadcasterMaxFeeAmount * 2n
    );
    if (!selected) throw Error("Fund and recognize Alice's Note before this scenario");
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress,
        amount: selected.note.amount / 2n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        inputs: [selected],
        outputs: [output],
    });
    const broadcaster = new BroadcasterClient({
        endpoint: broadcasterEndpoint,
        quoteSigner,
        feeRecipient,
        provenanceRequired: true,
    });
    // Quoting freezes fees only. Source data/proving is deferred until the ready transaction.
    const quoted = await broadcaster.quote(prepared, {
        maxFeeAmount: settings.broadcasterMaxFeeAmount,
    });
    const authorization = await quoted.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const authorized = await quoted.withWalletSignature(signature);
    const ready = await authorized.prove();
    console.log("Verified quote:", json(ready.broadcasterQuote()));
    const provenance = new Provenance({
        client: source,
        manifest: manifestIdentity,
        prover: sourceProver,
    });
    const sourceProof = await provenance.prove(ready);
    console.log("Save Provenance proof for recovery:", json(sourceProof));
    // Submission reuses this proof; the relay verifies it before broadcasting.
    const submitted = await broadcaster.submit(ready);
    const record = {
        sourceProof,
        submissionId: submitted.id,
    };
    console.log("Broadcast record:", json(record));
    console.log(json(submitted));
} finally {
    provider.destroy();
}
