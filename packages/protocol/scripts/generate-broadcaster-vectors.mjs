/** Recompute quote vectors from declarative public-test requests using the actual Core ABI. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { AbiCoder, Interface, Wallet, TypedDataEncoder, keccak256 } from "ethers";

const core = resolve(process.argv[2] ?? "../invisi-core");
const artifact = readFileSync(resolve(core, "contracts/out/InvisiCore.sol/InvisiCore.json"));
const abi = new Interface(
    JSON.parse(artifact).abi.filter(
        (item) =>
            item.type !== "function" || item.name !== "transact" || item.inputs[1]?.type === "tuple"
    )
);
const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
const file = new URL("../../sdk/src/broadcaster/testdata/broadcaster-v1.json", import.meta.url);
const vectors = JSON.parse(readFileSync(file, "utf8"));
const types = {
    Quote: [
        { name: "token", type: "address" },
        { name: "feeRecipient", type: "address" },
        { name: "feeAmount", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "maxGas", type: "uint256" },
        { name: "requestHash", type: "bytes32" },
        { name: "execution", type: "string" },
    ],
};

for (const row of vectors) {
    const args =
        row.method === "transact" ? [row.proof, row.request] : structuredClone(row.request);
    const fragment = abi.getFunction(row.method);
    assert(fragment, "unsupported fixture method");
    const canonical = structuredClone(args);
    const alternative = structuredClone(args);
    if (row.method === "revokeCredit") {
        assert.equal(args.length, 7);
        canonical[6] = "0x";
        alternative[6] = "0xaabb";
    } else {
        if (row.method !== "shield") {
            canonical[0] = "0x";
            alternative[0] = "0xaabb";
        }
        const funding =
            row.method === "transact"
                ? canonical[1].funding
                : row.method === "shield"
                  ? canonical[3]
                  : undefined;
        const alternativeFunding =
            row.method === "transact"
                ? alternative[1].funding
                : row.method === "shield"
                  ? alternative[3]
                  : undefined;
        if (funding) funding.signature = "0x";
        if (alternativeFunding) alternativeFunding.signature = "0xaabb";
    }
    const normalized = abi.encodeFunctionData(fragment, canonical);
    row.data = abi.encodeFunctionData(fragment, args);
    row.unsignedVariant = abi.encodeFunctionData(fragment, alternative);
    row.requestHash = keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "bytes"],
            ["InvisiBroadcasterIntentV1", row.method, normalized]
        )
    );
    row.quote.requestHash = row.requestHash;
    const domain = {
        name: "InvisiBroadcaster",
        version: "1",
        chainId: BigInt(row.trust.chainId),
        verifyingContract: row.trust.protocol,
    };
    const wallet = new Wallet(row.privateKey);
    assert.equal(wallet.address, row.trust.signer);
    row.signature = await wallet.signTypedData(domain, types, row.quote);
    row.quoteDigest = TypedDataEncoder.hash(domain, types, row.quote);
    row.artifactSha256 = artifactSha256;
    row.generatedBy =
        "independent ethers canonical Core ABI and EIP712 reference; public test requests/keys; no SDK hash implementation";
}
writeFileSync(file, JSON.stringify(vectors, null, 2) + "\n");
console.log(
    `Regenerated ${vectors.length} independent broadcaster calldata/hash/signature vectors`
);
