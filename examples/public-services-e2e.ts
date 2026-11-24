/** Explicit testnet acceptance with application-owned keys and real public services. */
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { JsonRpcProvider, Wallet as EvmWallet, Contract, parseEther, getBytes } from "ethers";
import { deliveryCodec } from "@invisi-labs/primitives";
import { settings } from "./settings.js";

if (!process.argv.includes("--execute") || !process.env.INVISI_TEST_ACCOUNTS) {
    console.log("Require --execute and INVISI_TEST_ACCOUNTS; --submit authorizes testnet writes.");
    process.exit(0);
}
const directory = resolve(process.env.INVISI_TEST_REPORT ?? ".cache/public-services-e2e");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const checkpoint = resolve(directory, "checkpoint.json");
const runReport = resolve(directory, `report-${Date.now()}.json`);
const saved = existsSync(checkpoint) ? JSON.parse(readFileSync(checkpoint, "utf8")) : {};
const json = (value: unknown) =>
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const report: any = { startedAt: new Date().toISOString(), stages: [], network: [] };
let stage = "initialize";
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
    const started = performance.now();
    let method = "HTTP";
    try {
        method = JSON.parse(String(options?.body)).method ?? method;
    } catch {}
    try {
        return await originalFetch(url, options);
    } finally {
        report.network.push({
            stage,
            method,
            endpoint: String(url),
            ms: performance.now() - started,
        });
    }
};
// Load clients after the observer, including module-owned bootstrap transports.
const {
    Invisi,
    Protocol,
    ProtocolRpcClient,
    Wallet,
    NoteOutput,
    buildReceivingKeyMessage,
    deriveReceivingKeysFromSignature,
} = await import("@invisi-labs/sdk");
const { NativeProver } = await import("@invisi-labs/prover/native");
const { Provenance, officialProvenanceClient } = await import("@invisi-labs/sdk/provenance");
const { WalletSession } = await import("@invisi-labs/session");
const { MemoryWalletStore } = await import("@invisi-labs/session/memory");
const chainRpcUrl = process.env.INVISI_CHAIN_RPC ?? settings.chainRpcUrl;
const provider = new JsonRpcProvider(chainRpcUrl, undefined, { batchMaxCount: 1 });
provider.on("debug", (event) => {
    if (event.action === "sendRpcPayload") {
        for (const request of Array.isArray(event.payload) ? event.payload : [event.payload]) {
            report.network.push({ stage, method: request.method, endpoint: chainRpcUrl });
        }
    }
});
const save = () => {
    writeFileSync(checkpoint, json(saved), { mode: 0o600 });
    writeFileSync(resolve(directory, "report.json"), json(report), { mode: 0o600 });
    writeFileSync(runReport, json(report), { mode: 0o600 });
};
async function measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    stage = name;
    const started = performance.now(),
        before = report.network.length;
    try {
        return await action();
    } finally {
        const result = {
            name,
            ms: performance.now() - started,
            requests: report.network.length - before,
        };
        report.stages.push(result);
        console.log(json(result));
        save();
    }
}

try {
    assert.equal((await provider.getNetwork()).chainId, 97n);
    assert.equal(settings.chainId, 97n);
    const accounts = JSON.parse(readFileSync(process.env.INVISI_TEST_ACCOUNTS, "utf8"));
    // Initialization derives receiving material independently; payments consume only saved public addresses.
    const local: any = {};
    for (const name of ["alice", "bob"]) {
        const signer = new EvmWallet(accounts[name].privateKey, provider);
        assert.equal(signer.address.toLowerCase(), accounts[name].address.toLowerCase());
        const signature = await signer.signMessage(buildReceivingKeyMessage(signer.address));
        const keys = deriveReceivingKeysFromSignature({ ownerAddress: signer.address, signature });
        local[name] = { signer, keys, wallet: Wallet.fromAddress(keys.getAddress()) };
    }
    const publicAccounts = Object.fromEntries(
        Object.entries(local).map(([name, row]: any) => [
            name,
            {
                address: row.signer.address,
                receivingAddress: row.wallet.getAddress(),
            },
        ])
    );
    writeFileSync(resolve(directory, "public-accounts.json"), json(publicAccounts), {
        mode: 0o600,
    });
    const rpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await measure("deployment", () => Protocol.fromRpc(rpc, provider));
    report.scope = protocol.context;
    const token = new Contract(
        settings.tokenAddress,
        [
            "function balanceOf(address) view returns(uint256)",
            "function allowance(address,address) view returns(uint256)",
            "function approve(address,uint256) returns(bool)",
            "function symbol() view returns(string)",
            "function decimals() view returns(uint8)",
        ],
        local.alice.signer
    );
    assert.equal(await token.symbol(), "iUSD");
    assert.equal(await token.decimals(), 18n);
    console.log(
        "scope",
        json(protocol.context),
        "balances",
        json({
            gas: await provider.getBalance(local.alice.signer.address),
            iUSD: await token.balanceOf(local.alice.signer.address),
        })
    );
    const bbBin = process.env.INVISI_BB_BIN;
    assert(bbBin, "INVISI_BB_BIN must reference verified BB 6");
    const prover = new NativeProver({ bbBin, threads: 4 });
    const source = await measure("provenance-initialize", () =>
        officialProvenanceClient(protocol.context)
    );
    const invisi = new Invisi({ provider, protocolRpc: rpc, prover, provenanceClient: source });
    await measure("provenance-status", async () => {
        const status = await source.getStatus();
        assert.equal(status.workerAvailable, true);
    });
    const clients = await measure("broadcaster-initialize", () =>
        protocol.initializeBroadcasters({ tokenAddress: settings.tokenAddress })
    );
    assert(clients.length, "No authenticated broadcaster supports iUSD");
    if (!process.argv.includes("--submit")) {
        console.log(
            "Read-only initialization passed; add --submit for testnet registration and payments."
        );
    } else {
        async function send(name: string, request: any) {
            assert.equal(BigInt(await provider.send("eth_chainId", [])), 97n);
            const tx = await local.alice.signer.sendTransaction(request);
            saved[name] = { hash: tx.hash };
            console.log(name, "transaction", tx.hash);
            save();
            const receipt = await tx.wait();
            assert.equal(receipt.status, 1);
            saved[name].block = receipt.blockNumber;
            save();
            return receipt;
        }
        for (const name of ["registration", "approve", "shield"]) {
            if (saved[name]?.hash && saved[name].block === undefined) {
                const receipt = await provider.waitForTransaction(saved[name].hash, 1, 120_000);
                assert(receipt && receipt.status === 1, `Saved ${name} transaction not confirmed`);
                saved[name].block = receipt.blockNumber;
                save();
            }
        }
        if (!saved.registration) {
            await measure("registration", async () => {
                let prepared;
                try {
                    prepared = await invisi.prepareRegistration({
                        wallet: local.bob.wallet,
                        update: false,
                    });
                } catch (error) {
                    if (
                        !(error instanceof Error) ||
                        error.message !== "wallet is already registered; prepare an update"
                    )
                        throw error;
                    prepared = await invisi.prepareRegistration({
                        wallet: local.bob.wallet,
                        update: true,
                    });
                }
                const auth = await prepared.exportRegistrationAuthorization();
                const signature = await local.bob.signer.signTypedData(
                    auth.domain,
                    auth.types,
                    auth.message
                );
                await send(
                    "registration",
                    await (await prepared.withSignature(signature)).exportTransaction()
                );
            });
        }
        if (!saved.shield) {
            await measure("shield", async () => {
                const amount = parseEther("10");
                const spender = protocol.context.protocolAddress;
                if ((await token.allowance(local.alice.signer.address, spender)) < amount) {
                    await send("approve", await token.approve.populateTransaction(spender, amount));
                }
                const output = await NoteOutput.create({
                    ...protocol.context,
                    tokenAddress: settings.tokenAddress,
                    amount,
                    recipient: { type: "invisi", address: publicAccounts.alice.receivingAddress },
                });
                const prepared = await invisi.prepareShield({
                    wallet: local.alice.wallet,
                    protocol,
                    tokenAddress: settings.tokenAddress,
                    outputs: [output],
                    funding: { payer: local.alice.signer.address, amount, authorization: "caller" },
                });
                await send("shield", await (await prepared.ready()).exportTransaction());
            });
        }
        const session = await WalletSession.connect({
            invisi,
            wallet: local.alice.wallet,
            protocol,
            store: new MemoryWalletStore(),
        });
        const decryptor = (name: string) => ({
            async detect(candidates: any[]) {
                return {
                    ownerAddress: local[name].wallet.ownerAddress,
                    results: candidates.map((candidate) =>
                        local[name].keys.getDetector().detectClue(getBytes(candidate.clue))
                            ? ("candidate" as const)
                            : ("not-recipient" as const)
                    ),
                };
            },
            async decryptNote(envelope: any, context: any) {
                const note = await local[name].keys.getViewer().decryptNote(envelope, context);
                return deliveryCodec(getBytes(envelope)[0]!).encode(note);
            },
            async decryptCredit(envelope: any, context: any) {
                const state = await local[name].keys.getViewer().decryptCredit(envelope, context);
                return deliveryCodec(getBytes(envelope)[0]!).encode(state);
            },
        });
        if (!saved.payment)
            await measure("scan-decrypt", async () => {
                for (let attempt = 0; attempt < 60; attempt++) {
                    const pending = await session.refresh({
                        fromBlock: BigInt(saved.shield.block),
                    });
                    await pending.decrypt(decryptor("alice"));
                    const balance = await session.balance(settings.tokenAddress);
                    if ((balance.availableKnown ?? 0n) >= parseEther("2")) {
                        console.log("authenticated Alice balance", json(balance));
                        return;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                }
                throw Error("Shield output was not indexed, finalized and decrypted");
            });
        if (!saved.payment) {
            const output = await NoteOutput.create({
                ...protocol.context,
                tokenAddress: settings.tokenAddress,
                amount: parseEther("1"),
                recipient: { type: "invisi", address: publicAccounts.bob.receivingAddress },
            });
            const prepared = await measure("prepare", () =>
                session.prepareTransfer({ tokenAddress: settings.tokenAddress, outputs: [output] })
            );
            const quoted = await measure("quote", () =>
                clients[0]!.quote(prepared, { maxFeeAmount: settings.broadcasterMaxFeeAmount })
            );
            const authorized = await measure("authorize", async () => {
                const request = await quoted.exportWalletAuthorization();
                return quoted.withWalletSignature(
                    await local.alice.signer.signTypedData(
                        request.domain,
                        request.types,
                        request.message
                    )
                );
            });
            const proved = await measure("prove", () => authorized.prove());
            const ready = await measure("ready-source", () => proved.ready());
            if (process.argv.includes("--provenance")) {
                const provenance = new Provenance({ prover, client: source });
                const proof = await measure("explicit-source-prove", () => provenance.prove(ready));
                const accepted = await measure("explicit-source-submit", () =>
                    provenance.submit(proof)
                );
                assert.equal(accepted.broadcastDecision, "allow");
                saved.source = accepted;
                save();
            }
            const submitted = await measure("submit", () => clients[0]!.submit(ready));
            saved.payment = submitted;
            save();
        }
        let result = saved.payment;
        await measure("payment-confirmation", async () => {
            for (let attempt = 0; attempt < 90; attempt++) {
                if (["rejected", "reverted", "expired"].includes(result.state))
                    throw Error(`Payment ${result.state}`);
                if (result.transactionHash) {
                    const receipt = await provider.getTransactionReceipt(result.transactionHash);
                    if (receipt) {
                        assert.equal(receipt.status, 1);
                        saved.payment = { ...result, block: receipt.blockNumber };
                        console.log("payment transaction", result.transactionHash);
                        save();
                        return;
                    }
                }
                await new Promise((resolve) => setTimeout(resolve, 3000));
                result = await clients[0]!.status(result.id);
            }
            throw Error("Payment inclusion timed out; preserve checkpoint for recovery");
        });
        if (saved.source) {
            await measure("source-recognition", async () => {
                const result = await source.waitTracking(saved.source.tracking.id, {
                    timeoutMs: 120_000,
                    intervalMs: 3000,
                });
                assert.equal(result.tracking.status, "recognized");
                saved.sourceRecognition = result.tracking.status;
                save();
            });
        }
        const recipient = await WalletSession.connect({
            invisi,
            wallet: local.bob.wallet,
            protocol,
            store: new MemoryWalletStore(),
        });
        await measure("recipient-scan-decrypt", async () => {
            for (let attempt = 0; attempt < 60; attempt++) {
                const pending = await recipient.refresh({ fromBlock: BigInt(saved.payment.block) });
                await pending.decrypt(decryptor("bob"));
                const balance = await recipient.balance(settings.tokenAddress);
                if ((balance.availableKnown ?? 0n) >= parseEther("1")) {
                    console.log("authenticated Bob balance", json(balance));
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 3000));
            }
            throw Error("Recipient output was not indexed, finalized and decrypted");
        });
        report.passed = true;
    }
} catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    console.error("Acceptance failed:", report.error);
    process.exitCode = 1;
} finally {
    save();
    provider.destroy();
    globalThis.fetch = originalFetch;
}
