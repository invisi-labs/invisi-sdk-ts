import { expect, it, vi } from "vitest";
import { Wallet as EvmWallet } from "ethers";
import { BroadcasterClient } from "@invisi-labs/sdk";
import type {
    FundingAuthorizationVerifier,
    SavedOperation,
} from "@invisi-labs/sdk/session-support";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "../wallet/WalletSession";
import { validateOperationSubmission } from "./submission-validation";

async function prepared(
    verifier?: FundingAuthorizationVerifier,
    opaqueSignature?: string,
    customStore = false,
    implicitNonce = false
) {
    const h = await fixture();
    h.reader.getTokenBalanceAllowance = async () => ({ balance: 10000n, allowance: 10000n });
    const store = customStore
        ? {
              persistent: false,
              readSnapshot: h.store.readSnapshot.bind(h.store),
              transaction: h.store.transaction.bind(h.store),
          }
        : h.store;
    const options = sessionOptions({
        ...h.options,
        store,
        ...(verifier ? { fundingVerifier: verifier } : {}),
    });
    const session = new WalletSession(options);
    await session.scanHistory(
        {
            async decryptNote() {
                throw Error("unexpected decryption");
            },
            async decryptCredit() {
                throw Error("unexpected decryption");
            },
        },
        { fromBlock: 13n, toBlock: 12n }
    );
    const payer = new EvmWallet(`0x${"01".repeat(32)}`);
    const op = await session.prepareShield({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        funding: {
            payer: payer.address as `0x${string}`,
            amount: 30n,
            authorization: "signature",
            ...(implicitNonce ? {} : { sigNonce: 0n }),
        },
    });
    const base = quoteClient(h.context);
    const submits: unknown[] = [];
    const service = { uncertain: false };
    const client = new BroadcasterClient({ ...base.configuration }, async (request) => {
        if (request.method !== "broadcaster_submitTransaction") return base.transport(request);
        submits.push(structuredClone(request.params));
        if (service.uncertain) throw Error("uncertain HTTP response");
        return {
            jsonrpc: "2.0",
            id: request.id,
            result: { id: "funding-submit-test", state: "pending" },
        };
    });
    const quoted = await client.quote(op, { maxFeeAmount: 10n });
    expect(quoted.preview().submissionValidation).toBe("required");
    const authorization = await quoted.exportFundingAuthorization();
    const signature =
        opaqueSignature ??
        (await payer.signTypedData(
            authorization.domain,
            authorization.types,
            authorization.message
        ));
    const ready = await quoted.withFundingSignature(signature);
    return {
        ...h,
        session,
        optionsForPeer: options,
        ready,
        client,
        submits,
        service,
        authorization,
    };
}

it.each([false, true])(
    "checks cached funding against one live deployment, head and nonce during submit (implicit=%s)",
    async (implicit) => {
        const h = await prepared(undefined, undefined, false, implicit);
        const calls: string[] = [];
        for (const key of Object.keys(h.reader)) {
            const fn = Reflect.get(h.reader, key);
            if (typeof fn === "function")
                Reflect.set(h.reader, key, async (...args: unknown[]) => {
                    calls.push(key);
                    return fn(...args);
                });
        }
        await h.client.submit(h.ready);
        expect(h.submits).toHaveLength(1);
        expect(
            Object.fromEntries(
                [...new Set(calls)].map((key) => [key, calls.filter((c) => c === key).length])
            )
        ).toEqual({
            getChainId: 2, // deployment preflight and post-persistence send identity
            getCode: 2,
            getLatestBlockNumber: 1,
            getBlock: 3,
            getFundingNonce: 1,
            getTokenBalanceAllowance: 1,
        });
    }
);

it.each([undefined, "0x1234"])(
    "retains the configured live verifier for EOA and contract-wallet signatures: %s",
    async (signature) => {
        const verifyTypedData = vi.fn(async () => true);
        const h = await prepared({ verifyTypedData }, signature);
        verifyTypedData.mockClear();
        verifyTypedData.mockResolvedValue(false);
        await expect(h.client.submit(h.ready)).rejects.toThrow(/invalid EVM funding signature/);
        expect(verifyTypedData).toHaveBeenCalledOnce();
        expect(h.submits).toHaveLength(0);
        expect(
            (await h.store.readSnapshot(h.scope)).operations[h.ready.id]!.payload
        ).not.toHaveProperty("broadcasterAttempted", true);
    }
);

it("reconstructs cached funding authorization rather than accepting a signature for another payer", async () => {
    const h = await prepared();
    const other = new EvmWallet(`0x${"02".repeat(32)}`);
    const signature = await other.signTypedData(
        h.authorization.domain,
        h.authorization.types,
        h.authorization.message
    );
    await h.store.transaction(h.scope, (state) => {
        (state.operations[h.ready.id]!.payload as SavedOperation).plan.funding.signature =
            signature as `0x${string}`;
    });
    const saved = (await h.store.readSnapshot(h.scope)).operations[h.ready.id]!
        .payload as SavedOperation;
    await expect(
        validateOperationSubmission(
            {
                reader: h.reader,
                store: h.store,
                scope: h.scope,
                options: { ...h.options, protocol: h.protocol.forToken(h.context.tokenAddress) },
            },
            saved
        )
    ).rejects.toThrow(/invalid EVM funding signature/);
    expect(h.submits).toHaveLength(0);
});

it.each(["nonce", "balance", "allowance", "chain", "code", "expiry", "anchor"])(
    "still rejects changed %s before transport and after resume",
    async (change) => {
        const h = await prepared();
        const block = await h.reader.getBlock(12n);
        if (change === "nonce") h.reader.getFundingNonce = async () => 1n;
        if (change === "balance")
            h.reader.getTokenBalanceAllowance = async () => ({ balance: 0n, allowance: 10000n });
        if (change === "allowance")
            h.reader.getTokenBalanceAllowance = async () => ({ balance: 10000n, allowance: 0n });
        if (change === "chain") h.reader.getChainId = async () => 1n;
        if (change === "code") h.reader.getCode = async () => "0x6001";
        if (change === "expiry")
            h.reader.getBlock = async () => ({ ...block, timestamp: 9000000000n });
        if (change === "anchor")
            h.reader.getBlock = async () => ({ ...block, hash: `0x${"99".repeat(32)}` });
        await expect(h.client.submit(h.ready)).rejects.toThrow();
        expect(h.submits).toHaveLength(0);
        const resumed = await h.session.resume(h.ready.id);
        await expect(h.client.submit(resumed)).rejects.toThrow();
        expect(h.submits).toHaveLength(0);
    }
);

it("keeps uncertain retry on the exact frozen packet without a fresh funding gate", async () => {
    const h = await prepared();
    h.service.uncertain = true;
    await expect(h.client.submit(h.ready)).rejects.toThrow(/uncertain HTTP response/);
    expect(h.submits).toHaveLength(1);
    h.reader.getFundingNonce = async () => {
        throw Error("must not revalidate uncertain funding");
    };
    h.reader.getChainId = async () => {
        throw Error("must not revalidate uncertain deployment");
    };
    h.service.uncertain = false;
    await h.client.submit(await h.session.resume(h.ready.id));
    expect(h.submits).toHaveLength(2);
    expect(h.submits[1]).toEqual(h.submits[0]);
});

it("keeps the final canonical fence after a live funding verifier returns", async () => {
    const verifyTypedData = vi.fn(async () => true);
    const h = await prepared({ verifyTypedData });
    const block = await h.reader.getBlock(12n);
    verifyTypedData.mockImplementation(async () => {
        h.reader.getBlock = async () => ({ ...block, hash: `0x${"98".repeat(32)}` });
        return true;
    });
    await expect(h.client.submit(h.ready)).rejects.toThrow(/block changed/);
    expect(h.submits).toHaveLength(0);
});

it.each(["builtin", "custom"])(
    "observes a competing resume through public wallet sessions with a %s store during the final network read",
    async (store) => {
        const h = await prepared(undefined, undefined, store === "custom");
        const peer = new WalletSession(h.optionsForPeer);
        let calls = 0;
        h.reader.getChainId = async () => {
            if (++calls === 2) await peer.resume(h.ready.id);
            return h.context.chainId;
        };
        await expect(h.client.submit(h.ready)).rejects.toThrow(/wallet changed|stale/);
        expect(h.submits).toHaveLength(0);
        expect((await h.store.readSnapshot(h.scope)).operations[h.ready.id]!.payload).toMatchObject(
            {
                broadcasterAttempted: true,
                externalized: true,
            }
        );
    }
);
