import { getBytes } from "ethers";
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
    console.log("Pass --execute and paste {sourceProof} from local history.");
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

const stored = (await readHostJson()) as { sourceProof: ProvenanceProof };
const provenance = new Provenance({ client: source });
// The service matches an already confirmed payment or continues waiting; no main transaction is sent.
console.log(json(await provenance.submit(stored.sourceProof)));
