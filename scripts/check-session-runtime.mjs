/** Exercise built entry points, including CommonJS class identity, without network access. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const { Wallet: EvmWallet } = require(
    require.resolve("ethers", { paths: [resolve("packages/sdk")] })
);
const word = (number) => `0x${number.toString(16).padStart(64, "0")}`;
for (const format of ["js", "cjs"]) {
    const load = (path) => {
        const target = resolve(`packages/${path}.${format}`);
        return format === "js" ? import(pathToFileURL(target).href) : require(target);
    };
    const sdk = await load("sdk/dist/index");
    const support = await load("sdk/dist/session-support");
    const session = await load("session/dist/index");
    const memory = await load("session/dist/memory");
    assert.equal(sdk.InvisiError, support.InvisiError, `${format} error class identity`);
    assert.equal(sdk.NoteOutput, support.NoteOutput, `${format} output class identity`);
    assert.equal(
        session.MemoryWalletStore,
        memory.MemoryWalletStore,
        `${format} store class identity`
    );

    const chainId = 31337n;
    const protocolAddress = "0x1111111111111111111111111111111111111111";
    const tokenAddress = "0x2222222222222222222222222222222222222222";
    const ownerAddress = "0x3333333333333333333333333333333333333333";
    const block = { number: 12n, hash: word(12), parentHash: word(11), timestamp: 2000000000n };
    const reader = {
        getChainId: async () => chainId,
        getCode: async () => "0x6000",
        getLatestBlockNumber: async () => block.number,
        getBlock: async () => block,
        getFundingNonce: async () => 0n,
    };
    const protocol = new sdk.Protocol({
        deployment: {
            chainId,
            protocol: {
                address: protocolAddress,
                runtimeCodeHash:
                    "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d",
                fromBlock: 0n,
            },
        },
    });
    const invisi = new sdk.Invisi({ chainReader: reader });
    const wallet = sdk.Wallet.fromAddress(ownerAddress);
    const store = new memory.MemoryWalletStore();
    const managed = await session.WalletSession.connect({ invisi, wallet, protocol, store });
    const output = await sdk.NoteOutput.create({
        chainId,
        protocolAddress,
        tokenAddress,
        amount: 1n,
        recipient: { type: "evm", address: ownerAddress, envelope: false },
    });
    const request = {
        wallet,
        protocol,
        tokenAddress,
        outputs: [output],
        funding: { payer: ownerAddress, amount: 1n, authorization: "caller" },
    };
    const detached = await invisi.prepareShield(request);
    const operation = await managed.prepareShield({
        tokenAddress,
        outputs: [output],
        funding: request.funding,
    });
    assert.equal(
        operation.preview().outputs[0].commitment,
        detached.preview().outputs[0].commitment
    );
    assert.equal(Object.keys((await store.readSnapshot(managed.scope)).operations).length, 1);
    const operator = new EvmWallet(`0x${"03".repeat(32)}`);
    const broadcaster = new sdk.BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: operator.address,
            feeRecipient: operator.address,
        },
        async (envelope) => {
            const params = envelope.params[0];
            if (envelope.method === "broadcaster_estimateQuote")
                return {
                    jsonrpc: "2.0",
                    id: envelope.id,
                    result: { feeRecipient: operator.address, feeAmount: "1", maxGas: "1000000" },
                };
            const intent = sdk.decodeBroadcasterIntent(params.data).request.params;
            const quote = {
                token: intent.token,
                feeRecipient: operator.address,
                feeAmount: String(intent.feeAmount),
                deadline: String(intent.deadline),
                maxGas: "1000000",
                requestHash: sdk.broadcasterRequestHash(params.data),
            };
            return {
                jsonrpc: "2.0",
                id: envelope.id,
                result: {
                    quote,
                    signature: await operator.signTypedData(
                        sdk.broadcasterQuoteDomain({
                            chainId,
                            protocol: protocolAddress,
                            signer: operator.address,
                        }),
                        sdk.broadcasterQuoteTypes,
                        quote
                    ),
                },
            };
        }
    );
    const quotedDetached = await broadcaster.quote(detached, { maxFeeAmount: 2n });
    const quotedManaged = await broadcaster.quote(operation, { maxFeeAmount: 2n });
    assert(
        quotedDetached instanceof sdk.PreparedTransaction,
        `${format} detached quote return type`
    );
    assert(quotedManaged instanceof session.Operation, `${format} managed quote return type`);
    assert.equal(quotedDetached.preview().feeAmount, 1n);
    assert.equal(quotedManaged.preview().feeAmount, 1n);

    await assert.rejects(
        managed.prepareShield({
            tokenAddress,
            outputs: [output],
            funding: { ...request.funding, amount: 0n },
        }),
        (error) => error instanceof sdk.InvisiError
    );
}
console.log(
    "Built session interoperability PASS: ESM and CommonJS, shared class identity, preparation and broadcaster quotation"
);
