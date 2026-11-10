import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, getBytes, Wallet as EthersWallet } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput } from "@invisi-labs/sdk";
import {
    Provenance,
    ProvenanceClient,
    DEFAULT_PROVENANCE_ENDPOINT,
    authenticateManifest,
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

if (!process.argv.includes("--execute")) {
    console.log(
        "Pass --execute to prepare a direct payment, build its recoverable source proof and submit for automatic chain matching."
    );
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
    const tokenAddress = settings.tokenAddress;
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
    });
    const candidates = await discoverCandidates({
        provider,
        protocolRpc,
        protocol,
        wallet: alice.publicWallet,
        nativeWallet,
        tokenAddress,
    });
    const input = candidates.find((note) => note.note.amount > 1n);
    if (!input) throw Error("Fund and recognize Alice's Note first");
    const output = await NoteOutput.create({
        ...protocol.context,
        tokenAddress,
        amount: input.note.amount / 2n,
        recipient: { type: "invisi", address: bob.receivingAddress },
    });
    const prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        inputs: [input],
        outputs: [output],
    });
    const signer = new EthersWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (signer.address.toLowerCase() !== alice.publicWallet.ownerAddress.toLowerCase()) {
        throw Error("ALICE_PRIVATE_KEY must match Alice's Note owner");
    }
    const authorization = await prepared.exportWalletAuthorization();
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const ready = await (await prepared.withWalletSignature(signature)).prove();
    const provenance = new Provenance({
        client: source,
        manifest: manifestIdentity,
        prover: sourceProver,
    });
    const sourceProof = await provenance.prove(ready);
    // The App must persist this public proof packet before sending; do not save any witness/opening in public history.
    console.log("Save Provenance recovery packet:", json(sourceProof));
    console.log(
        "Transaction for independent host submission:",
        json(await ready.exportTransaction())
    );
    // The host independently decides when to send; Source matches a past or future confirmed payment.
    const accepted = await provenance.submit(sourceProof);
    console.log("Provenance submission:", json(accepted));
} finally {
    provider.destroy();
}
