import { Provenance, type ProvenanceProof } from "@invisi-labs/sdk/provenance";
import { json, readHostJson } from "../example-io.js";

if (!process.argv.includes("--execute")) {
    console.log("Pass --execute and paste {sourceProof} from local history.");
    process.exit(0);
}
const stored = (await readHostJson()) as { sourceProof: ProvenanceProof };
const provenance = new Provenance();
// The service matches an already confirmed payment or continues waiting; no main transaction is sent.
console.log(json(await provenance.submit(stored.sourceProof)));
