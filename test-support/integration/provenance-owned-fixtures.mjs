/**
 * Synthetic off-chain Provenance service screening fixture for owned local acceptance only.
 * Independent of the removed Core screening hook; never imported by the production SDK.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export function provisionOwnedScreeningFixture(directory) {
    writeFileSync(
        join(directory, "address-list.json"),
        JSON.stringify({ version: "1", dataVersion: "owned-synthetic-e2e-v1", denyAddresses: [] }) +
            "\n",
        { mode: 0o600, flag: "wx" }
    );
}
