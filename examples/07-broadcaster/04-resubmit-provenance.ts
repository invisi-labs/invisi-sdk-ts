import { JsonRpcProvider, getBytes } from "ethers";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import {
    Provenance,
    ProvenanceClient,
    DEFAULT_PROVENANCE_ENDPOINT,
} from "@invisi-labs/sdk/provenance";
import type { TrustContext, ProvenanceProof } from "@invisi-labs/sdk/provenance";
import { settings } from "../settings.js";
import { json, readHostJson } from "../host-transport.js";
// Match these public trust pins to the deployment selected in ../settings.ts.
const provenanceEndpoint = DEFAULT_PROVENANCE_ENDPOINT;
const protocolAddress = "0x<20-byte-protocol-address>" as `0x${string}`;
const chainGeneration = "1";
const providerId = "0x<32-byte-provider-id>";
const signingKeyId = "0x<sha256-of-pinned-public-key>";
const signingPublicKey = "0x<32-byte-pinned-ed25519-public-key>";

if (!process.argv.includes("--execute")) {
    console.log("Pass --execute and paste {sourceProof, transactionHash} from local history.");
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

const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    const stored = (await readHostJson()) as {
        sourceProof: ProvenanceProof;
        transactionHash: string;
    };
    const provenance = new Provenance({
        client: source,
        chainReader: new EthersChainReader(provider),
    });
    // This validates the packet and actual canonical transaction; it neither signs nor sends a main transaction.
    console.log(
        json(
            await provenance.submit(stored.sourceProof, { transactionHash: stored.transactionHash })
        )
    );
} finally {
    provider.destroy();
}
