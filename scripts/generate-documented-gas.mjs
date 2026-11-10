/** Generate portable documented medians, not authenticated receipt measurements. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
const vectorsOnly = process.argv.includes("--vectors-only");
const root = resolve(
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "../protocol-docs"
);
const files = [
    "5.1-credit-create.md",
    "5.2-credit-update.md",
    "5.3-credit-revoke.md",
    "5.4-credit-draw.md",
    "5.5-daily-transact.md",
    "5.6-daily-transact-paths.md",
];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const conditions = [
    "First owner/token grant allocation at shard1/slot0, empty protocol tree, two Credit deliveries. See the hashed source for exact fee and policy configuration.",
    "Update after a successful debit of7 base units; preserve all usage fields and change limits/expiry. Preparation transactions excluded. See the hashed source for exact fee configuration.",
    "Owner direct, EOA relay or reference ERC1271/EIP7702 relay; first bitmap-word write or an already nonempty word. Three successful receipt medians per scenario; preparation and delegation excluded.",
    "Local Anvil31337, Prague, real verifiers, MockERC20Permit, owners preminted and max-approved. Each distinct payer contributes7 base units; one spender, one ordinary recipient Note. Inputs in tree1, cursor=N; timestamp2000000000, deadline+86400. Credit ciphertext size/layout from the hashed measured source, Note160, clue68. No memo/FMD. One independently verified proof per statement reused across three successful snapshot-isolated transactions with distinct gasPrice/transaction hashes. Block30m, transaction budget16777216; preparation/mint/approve excluded. See the hashed source for exact fee and private limits.",
    "2026-11-08, source eb5b88705227e61383e8620d7a34887a61617e08. Local Anvil31337, Prague, Solidity0.8.38 optimizer200, real verifiers, MockERC20Permit, direct caller funding without Permit; at most one depth16 Note tree without rollover. Ciphertext160 plus clue68 per output, empty memo. Three receipt medians from identical snapshots. N=input+output slots; choose the higher public-funding/mixed median at each N. Mixed recipe: one10UNIT input,4UNIT deposit,9UNIT private outputs,3UNIT withdrawal,2UNIT accrued fee; C1 withdraws12UNIT plus2UNIT fee. UNIT=10^16. Excludes deployment/mint/approve/input shielding.",
    "Same environment and accounting as5.5. C2/C10/C190 compare public-funding0->C, private1->C-1 and withdrawalC->0 using real Notes. Three successful receipt medians per workload; see the hashed source for fee configuration.",
];
const sources = files.map((path, index) => {
    const text = readFileSync(join(root, "05-benchmarks", path), "utf8");
    return {
        path: "05-benchmarks/" + path,
        sha256: sha(text),
        conditions: conditions[index],
        text,
    };
});
const measuredCreditText = sources[3].text.split("## ")[0];
const creditHeader = measuredCreditText.match(/Credit manifest(\d+)\/format(\d+)/);
if (!creditHeader) throw Error("Credit manifest/format provenance missing from5.4");
const measuredCreditSha = measuredCreditText.match(
    /creditManifestSha256\s*[:=]\s*[`"]?([a-f0-9]{64})/i
)?.[1];
const measuredCreditBytes = Number(
    measuredCreditText.match(/creditCiphertextBytes\s*[:=]\s*(\d+)/i)?.[1] ??
        measuredCreditText.match(/\u6388\u4fe1\u5bc6\u6587\u5404\s*(\d+)B/)?.[1]
);
if (!Number.isInteger(measuredCreditBytes))
    throw Error("Credit ciphertext byte provenance missing");
const creditIdentity = {
    ...(measuredCreditSha ? { creditManifestSha256: measuredCreditSha } : {}),
    creditManifestVersion: Number(creditHeader[1]),
    creditFormatVersion: Number(creditHeader[2]),
};
const packaged = JSON.parse(readFileSync("packages/prover/circuits/manifest.json", "utf8"));
const packagedCredit = packaged.manifests.find((m) => m.name === "credit");
const packagedCreditIdentity = {
    creditManifestSha256: packagedCredit.sha256,
    creditManifestVersion: packagedCredit.version,
    creditFormatVersion: packagedCredit.formatVersion,
};
const rows = [];
for (const [index, source] of sources.entries()) {
    const table = source.text
        .split("## ")[0]
        .split("\n")
        .filter((line) => line.startsWith("|"));
    let gasColumn = index === 3 ? 2 : 1,
        feeColumn = -1;
    for (const line of table) {
        const cells = line
            .split("|")
            .slice(1, -1)
            .map((x) => x.trim());
        const headerGas = cells.findIndex((value, i) => i > 0 && value.includes("gas"));
        if (headerGas >= 0) {
            gasColumn = headerGas;
            feeColumn = cells.findIndex((value) => /fee/i.test(value));
            continue;
        }
        let shape, gas;
        if (index < 2 && /^\d[\d,]*$/.test(cells[gasColumn] ?? "")) {
            shape = {
                kind: index === 0 ? "create-credit" : "update-credit",
                scenario: index === 0 ? "first-allocation-empty-tree" : "after-draw-preserve-usage",
            };
            gas = cells[gasColumn];
        }
        if (index === 2 && /^\d[\d,]*$/.test(cells[gasColumn] ?? "")) {
            shape = {
                kind: "revoke-credit",
                authorization: cells[0].startsWith("owner")
                    ? "direct"
                    : cells[0].startsWith("EOA")
                      ? "eoa"
                      : "erc1271",
                bitmapWord: cells[0].includes("\u9996\u6b21") ? "empty" : "nonempty",
            };
            gas = cells[gasColumn];
        }
        if (index === 3 && cells[0]?.match(/N=(\d+)/)) {
            const n = Number(cells[0].match(/N=(\d+)/)[1]);
            shape = {
                kind: "draw-credit",
                capacity: Number(cells[1]),
                creditInputs: n,
                distinctPayers: n,
                sourceTrees: 1,
                noteOutputs: 1,
                creditOutputs: n,
                creditCiphertextBytes: measuredCreditBytes,
                noteCiphertextBytes: 160,
                clueBytes: 68,
                scenario: "distinct-payers",
            };
            gas = cells[gasColumn];
        }
        if (index >= 4 && cells[0]?.match(/N=(\d+) \/ C(\d+)（(\d+)→(\d+)）/)) {
            const m = cells[0].match(/N=(\d+) \/ C(\d+)（(\d+)→(\d+)）/);
            shape = {
                kind: "transact",
                capacity: Number(m[2]),
                noteInputs: Number(m[3]),
                noteOutputs: Number(m[4]),
                sourceTrees: Number(m[3]) ? 1 : 0,
                noteCiphertextBytes: 160,
                clueBytes: 68,
                scenario: cells[0].startsWith("\u516c\u5f00")
                    ? "public-funding"
                    : cells[0].startsWith("\u7eaf")
                      ? "private"
                      : cells[0].startsWith("\u63d0\u73b0")
                        ? "withdrawal"
                        : "mixed",
            };
            gas = cells[gasColumn];
        }
        if (shape) {
            if (!/^\d[\d,]*$/.test(gas)) throw Error("invalid gas");
            const credit = index <= 3;
            const feeMatch = cells.join(" ").match(/fee(?:Amount)?\s*[=:]?\s*(\d+)/i),
                feeValue = feeColumn >= 0 ? cells[feeColumn]?.replaceAll(",", "") : feeMatch?.[1],
                feeEnabled = !!feeValue && /^\d+$/.test(feeValue) && BigInt(feeValue) > 0n;
            if (credit && feeColumn >= 0 && !/^\d+$/.test(feeValue ?? ""))
                throw Error("invalid documented fee amount");
            if (credit)
                shape = {
                    ...shape,
                    feeEnabled,
                    feeMechanism: feeEnabled
                        ? index === 3
                            ? "draw-deduction"
                            : "owner-pull"
                        : "none",
                };
            rows.push({
                releaseIdentity: credit
                    ? creditIdentity
                    : { userManifestVersion: 4, userFormatVersion: 7 },
                id: `${index + 1}-${rows.length + 1}`,
                source: source.path,
                shape,
                gasUnits: gas.replaceAll(",", ""),
                statistic: "median",
                sampleCount: 3,
            });
        }
    }
}
const catalog = vectorsOnly
    ? JSON.parse(readFileSync("packages/protocol/src/gas/data/documented-references.json", "utf8"))
    : {
          formatVersion: 1,
          kind: "documented-reference",
          docsCommit: execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
              encoding: "utf8",
          }).trim(),
          sources: sources.map(({ text, ...s }) => s),
          assumptions: [
              "Local Anvil31337, Prague, real verifiers and reference token; not a live chain gas estimate.",
              "Medians transcribed from documentation; raw receipts and artifact fingerprints are not included.",
              "Credit draw samples use distinct payers only. Same-payer batches are not covered.",
              "No extrapolation; aggregate documents 5.7 and 5.8 describe historical experiments and are excluded.",
          ],
          references: rows,
      };
const target = "packages/protocol/src/gas/data/";
if (!vectorsOnly)
    writeFileSync(target + "documented-references.json", JSON.stringify(catalog, null, 2) + "\n");
writeFileSync(
    target + "documented-reference-vectors.json",
    JSON.stringify(
        {
            formatVersion: 1,
            catalogSha256: sha(JSON.stringify(catalog)),
            packagedCreditIdentity,
            vectors: catalog.references.map((r) => ({
                query: r.shape,
                available:
                    r.shape.kind === "transact" ||
                    (!!r.releaseIdentity.creditManifestSha256 &&
                        r.releaseIdentity.creditManifestSha256 ===
                            packagedCreditIdentity.creditManifestSha256 &&
                        r.releaseIdentity.creditManifestVersion ===
                            packagedCreditIdentity.creditManifestVersion &&
                        r.releaseIdentity.creditFormatVersion ===
                            packagedCreditIdentity.creditFormatVersion),
                gasUnits: r.gasUnits,
            })),
            unsupported: [
                { kind: "aggregate" },
                { kind: "draw-credit", capacity: 2, creditInputs: 2, distinctPayers: 1 },
            ],
        },
        null,
        2
    ) + "\n"
);
console.log(`Generated ${rows.length} documented references`);
