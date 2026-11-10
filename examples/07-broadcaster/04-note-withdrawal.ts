import { readFile, open } from "node:fs/promises";
import { join } from "node:path";
import { JsonRpcProvider, getBytes } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, BroadcasterClient } from "@invisi-labs/sdk";
import { ProvenanceClient, authenticateManifest } from "@invisi-labs/sdk/provenance";
import type { TrustContext } from "@invisi-labs/sdk/provenance";
import { LocalProvenanceProver } from "@invisi-labs/prover/provenance";
import { NativeProver } from "@invisi-labs/prover/native";
import { settings } from "../settings.js";
import { getAccounts } from "../accounts.js";
import { nativeWallet, json } from "../host-transport.js";
import { discoverCandidates } from "../03-hidden-amount/discover-candidates.js";

if (!process.argv.includes("--execute")) {
    console.log("Pass --execute to prepare/prove; add --submit to broadcast. Review README first.");
    process.exit(0);
}
const config = JSON.parse(await readFile(process.env.EXAMPLE_CONFIG!, "utf8"));
const pin = "f90f2ce43218de158c6392fa19e6517dda703c35823a4aa5bfc20b50788ad282";
const trust: TrustContext = {
    chainId: config.chainId,
    protocolAddress: config.protocolAddress,
    policyId: config.policyId,
    chainGeneration: config.generation,
    providerId: config.providerId,
    manifestSha256: pin,
    signingKeys: { [config.signingKeyId]: getBytes(config.signingPublicKey) },
};
const source = new ProvenanceClient(config.endpoint, trust);
const manifest = await readFile(join(config.assetRoot, "manifest.json"));
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
            artifact: await readFile(join(config.assetRoot, entry.artifact)),
            verificationKey: await readFile(join(config.assetRoot, entry.vk)),
        };
    },
});

const provider = new JsonRpcProvider(config.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== BigInt(config.chainId))
        throw Error("Primary chain mismatch");
    const protocolRpc = new ProtocolRpcClient(config.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (protocol.context.protocolAddress.toLowerCase() !== config.protocolAddress.toLowerCase())
        throw Error("Pinned deployment mismatch");
    const [alice] = getAccounts();
    const tokenAddress = settings.tokenAddress;
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin: settings.bbBin }),
        provenance: { client: source, manifest: manifestIdentity, prover: sourceProver },
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
    const feeClient = new BroadcasterClient({
        ...config.broadcaster,
        provenancePolicyId: config.policyId,
    });
    const sweep = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        inputs: [selected],
        outputs: [],
        withdrawal: { to: alice.publicWallet.ownerAddress, amount: selected.note.amount },
    });
    const preliminaryFee = BigInt(
        (await feeClient.quote((await sweep.exportBroadcasterIntent()).data, { mode: "estimate" }))
            .feeAmount
    );
    if (preliminaryFee >= selected.note.amount) throw Error("Insufficient Note for relay fee");
    // Keep one input and zero outputs: private withdrawal still needs a source proof.
    let prepared = await invisi.prepareTransfer({
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        inputs: [selected],
        outputs: [],
        withdrawal: {
            to: alice.publicWallet.ownerAddress,
            amount: selected.note.amount - preliminaryFee,
        },
    });
    const broadcaster = new BroadcasterClient({
        ...config.broadcaster,
        provenancePolicyId: config.policyId,
    });
    // Fee convergence freezes the statement before local source proving and tracked preflight.
    prepared = await prepared.withBroadcaster(broadcaster, {
        maxFeeAmount: settings.broadcasterMaxFeeAmount,
        feeSource: "private-inputs",
    });
    if (prepared.getOutputs().length !== 0)
        throw Error("Relay fee changed; prepare a fresh exact withdrawal before consent");
    const request = await prepared.exportWalletRequest(crypto.randomUUID());
    const responses = await nativeWallet.execute([request]);
    const response = responses.find((item) => item.id === request.id);
    if (!response) throw Error("Missing wallet response");
    const ready = await (await prepared.withWalletResponse(response)).prove();

    console.log("Verified quote:", json(ready.broadcasterQuote()));
    if (process.argv.includes("--submit")) {
        const broadcastId = crypto.randomUUID();
        const tracking = ready.provenanceTracking()!;
        const record = {
            data: (await ready.exportTransaction()).data,
            broadcastId,
            trackingId: tracking.id,
            operationDigest: tracking.operationDigest,
        };
        const file = await open(process.env.PROVENANCE_RECORD!, "wx", 0o600);
        try {
            await file.writeFile(json(record));
            await file.sync();
        } finally {
            await file.close();
        }
        // Retain this public record if submission times out; query the same broadcast ID.
        console.log(json(await ready.submitBroadcaster(broadcaster, broadcastId)));
    }
} finally {
    provider.destroy();
}
