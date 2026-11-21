import { describe, expect, it } from "vitest";
import { Interface, ZeroAddress } from "ethers";
import { paymentRouterAbi, paymentRouterAccountAbi, noSwapRoute, hashRoute } from "./index";
describe("canonical PaymentRouter", () => {
    it("exposes the three router calls and account wrapper", () => {
        const router = new Interface(paymentRouterAbi);
        for (const name of ["payNative", "payToken", "payTokenFor"])
            expect(router.getFunction(name)).toBeTruthy();
        expect(
            new Interface(paymentRouterAccountAbi).getFunction("executeNativePayment")
        ).toBeTruthy();
    });
    it("hashes the empty route tuple", () => {
        expect(noSwapRoute()).toEqual({ channel: 0, path: "0x", target: ZeroAddress, data: "0x" });
        expect(hashRoute(noSwapRoute())).toMatch(/^0x[0-9a-f]{64}$/);
    });
});

import { readFileSync } from "node:fs";
import { recoverAddress } from "ethers";
import {
    buildRouterPayment,
    hashCoreRequest,
    hashPaymentIntent,
    intentTypedData,
    hashNativePayment,
    nativePaymentTypedData,
    buildAccountPayment,
    relayEnvelope,
    type RouterPayment,
} from "./canonical";
const vectors = JSON.parse(
    readFileSync(
        new URL("../../../test-support/payment-router/intent-vectors.json", import.meta.url),
        "utf8"
    ),
    (key, value) =>
        typeof value === "string" && /^\d+$/.test(value)
            ? key === "version"
                ? value
                : key === "v"
                  ? Number(value)
                  : BigInt(value)
            : value
);
for (const c of vectors.cases) {
    it("matches the shared " + c.name + " vector", () => {
        const { addresses, chainId } = vectors;
        const p: RouterPayment = {
            proof: c.proof,
            request: c.request,
            intent: c.intent,
            route: c.route,
            routerAddress: addresses.router,
            wethAddress: addresses.weth,
            ...(c.method === "payTokenFor" ? { signature: c.signature } : {}),
        };
        expect(hashCoreRequest(c.proof, c.request)).toBe(vectors.coreRequestHash);
        expect(hashRoute(c.route)).toBe(c.intent.routeHash);
        const typed = intentTypedData(chainId, addresses.router, c.intent);
        expect(typed.domain).toEqual(c.intentDomain);
        expect(typed.types).toEqual(c.intentTypes);
        const digest = hashPaymentIntent(chainId, addresses.router, c.intent);
        expect(digest).toBe(c.intentDigest);
        expect(recoverAddress(digest, c.signature)).toBe(addresses.player);
        const call = buildRouterPayment(p);
        expect(call).toEqual(c.call);
        if (c.method === "payTokenFor")
            expect(relayEnvelope(c.coreCalldata, call).router.value).toBe("0");
        if (c.account) {
            const a = c.account,
                options = {
                    chainId,
                    implementation: a.implementation,
                    payer: addresses.player,
                    routerCodeHash: a.routerCodeHash,
                    routerCall: call,
                    nonce: a.payment.nonce,
                    deadline: a.payment.deadline,
                    relayer: addresses.relayer,
                };
            const typed = nativePaymentTypedData(options);
            expect(typed.domain).toEqual(a.domain);
            expect(typed.types).toEqual(a.types);
            expect(hashNativePayment(options)).toBe(a.digest);
            expect(recoverAddress(a.digest, a.signature)).toBe(addresses.player);
            const outer = buildAccountPayment(options, a.signature);
            expect(outer).toEqual(a.call);
            expect(relayEnvelope(c.coreCalldata, outer).router.value).toBe("0");
        }
    });
}

import { AbiCoder, Wallet, Signature, id, keccak256 } from "ethers";
import {
    hashRelayEnvelope,
    PaymentMode,
    buildPaymentIntent,
    signPaymentIntent,
    delegationRequest,
    validateDelegation,
    inputApproval,
    inputPermitTypedData,
} from "./canonical";
describe("canonical authorization and relay boundaries", () => {
    const relayed = vectors.cases.find((c: any) => c.name === "relayed-token");
    it("binds all outer fields and uses the Go envelope ABI", () => {
        const call = relayed.call,
            coder = AbiCoder.defaultAbiCoder();
        const authHash = keccak256(
            coder.encode(["(uint256,address,uint64,uint8,bytes32,bytes32)[]"], [[]])
        );
        const expected = keccak256(
            coder.encode(
                ["bytes32", "uint256", "address", "address", "uint256", "bytes32", "bytes32"],
                [
                    id(
                        "InvisiPaymentRouterEnvelope(uint256 chainId,address core,address to,uint256 value,bytes32 dataHash,bytes32 authorizationListHash)"
                    ),
                    vectors.chainId,
                    vectors.addresses.core,
                    call.to,
                    0,
                    keccak256(call.data),
                    authHash,
                ]
            )
        );
        expect(hashRelayEnvelope(vectors.chainId, vectors.addresses.core, call)).toBe(expected);
        expect(hashRelayEnvelope(vectors.chainId + 1n, vectors.addresses.core, call)).not.toBe(
            expected
        );
        expect(
            hashRelayEnvelope(vectors.chainId, vectors.addresses.core, {
                ...call,
                to: vectors.addresses.player,
            })
        ).not.toBe(expected);
        expect(() =>
            hashRelayEnvelope(vectors.chainId, vectors.addresses.core, { ...call, value: 1n })
        ).toThrow();
        expect(() =>
            relayEnvelope(relayed.coreCalldata, { ...call, data: call.data + "00" })
        ).toThrow("noncanonical");
        expect(() => relayEnvelope("0x1234", call)).toThrow("embedded Core");
    });
    it("supports explicit delegation signing and serializes geth authorization quantities", async () => {
        const wallet = new Wallet("0x" + "12".repeat(32));
        const request = delegationRequest(
            vectors.chainId,
            vectors.addresses.implementation,
            8,
            "0x"
        );
        const auth = await wallet.authorize(request);
        validateDelegation(auth, wallet.address as any, request.address, vectors.chainId, 8n);
        expect(() =>
            validateDelegation(auth, vectors.addresses.player, request.address, vectors.chainId, 8n)
        ).toThrow();
        expect(() => delegationRequest(vectors.chainId, request.address, 8, "0xef0100")).toThrow(
            "already"
        );
        expect(
            hashRelayEnvelope(vectors.chainId, vectors.addresses.core, relayed.call, [auth])
        ).not.toBe(hashRelayEnvelope(vectors.chainId, vectors.addresses.core, relayed.call));
        const c = vectors.cases.find((c: any) => c.account),
            inner = structuredClone(c.call);
        const abi = new Interface(paymentRouterAbi),
            decoded = abi.decodeFunctionData("payNative", inner.data);
        const intent = { ...c.intent, payer: wallet.address, refundRecipient: wallet.address };
        inner.data = abi.encodeFunctionData("payNative", [decoded[0], decoded[1], intent, c.route]);
        const outer = buildAccountPayment(
            {
                chainId: vectors.chainId,
                implementation: request.address,
                payer: wallet.address as any,
                routerCodeHash: c.account.routerCodeHash,
                routerCall: inner,
                nonce: 3n,
                deadline: intent.deadline,
                relayer: vectors.addresses.relayer,
            },
            c.account.signature
        );
        const result = relayEnvelope(c.coreCalldata, outer, [auth]);
        expect(result.router.authorizationList?.[0]).toEqual({
            address: auth.address,
            chainId: "0x7a69",
            nonce: "0x8",
            yParity: auth.signature.yParity ? "0x1" : "0x0",
            r: auth.signature.r,
            s: auth.signature.s,
        });
    });
    it("constructs same-token and native wrap calls without a swap", () => {
        for (const mode of [PaymentMode.DirectToken, PaymentMode.DirectNative]) {
            const c = structuredClone(vectors.cases[0]),
                route = noSwapRoute();
            const tokenIn =
                mode === PaymentMode.DirectToken ? vectors.addresses.token : ZeroAddress;
            if (mode === PaymentMode.DirectNative) c.request.params.token = vectors.addresses.weth;
            const intent = buildPaymentIntent(
                { ...c.intent, tokenIn, mode },
                c.proof,
                c.request,
                route
            );
            expect(
                buildRouterPayment({
                    routerAddress: vectors.addresses.router,
                    wethAddress: vectors.addresses.weth,
                    proof: c.proof,
                    request: c.request,
                    intent,
                    route,
                }).value
            ).toBe(mode === PaymentMode.DirectNative ? intent.amountInMaximum : 0n);
            intent.routeHash = ("0x" + "00".repeat(32)) as `0x${string}`;
            expect(() =>
                buildRouterPayment({
                    routerAddress: vectors.addresses.router,
                    wethAddress: vectors.addresses.weth,
                    proof: c.proof,
                    request: c.request,
                    intent,
                    route,
                })
            ).toThrow("hash mismatch");
        }
    });
    it("keeps token withdrawal authorization separate from intent authorization", async () => {
        const signer = Wallet.createRandom();
        const c = structuredClone(relayed),
            intent = { ...c.intent, payer: signer.address };
        const signature = await signPaymentIntent(
            signer,
            vectors.chainId,
            vectors.addresses.router,
            intent
        );
        expect(
            recoverAddress(
                hashPaymentIntent(vectors.chainId, vectors.addresses.router, intent),
                signature
            )
        ).toBe(signer.address);
        await expect(
            signPaymentIntent(
                Wallet.createRandom(),
                vectors.chainId,
                vectors.addresses.router,
                intent
            )
        ).rejects.toThrow("signer mismatch");
        expect(inputApproval(vectors.addresses.token, vectors.addresses.router, 12n).to).toBe(
            vectors.addresses.token
        );
        expect(
            inputPermitTypedData(
                {
                    name: "Token",
                    version: "1",
                    chainId: vectors.chainId,
                    verifyingContract: vectors.addresses.token,
                },
                signer.address as any,
                vectors.addresses.router,
                12n,
                2n,
                1900000000n
            ).message.spender
        ).toBe(vectors.addresses.router);
    });
});

for (const vector of JSON.parse(
    readFileSync(
        new URL("../../../test-support/payment-router/envelope-vectors.json", import.meta.url),
        "utf8"
    )
)) {
    it("matches Go envelope golden vector " + vector.name, () => {
        expect(
            hashRelayEnvelope(
                BigInt(vector.chainId),
                vector.core,
                {
                    ...vector.envelope,
                    value: 0n,
                },
                (vector.envelope.authorizationList ?? []).map((a: any) => ({
                    address: a.address,
                    chainId: BigInt(a.chainId),
                    nonce: BigInt(a.nonce),
                    signature: Signature.from({
                        r: a.r,
                        s: a.s,
                        yParity: Number(BigInt(a.yParity)) as 0 | 1,
                    }),
                }))
            )
        ).toBe(vector.hash);
    });
}

import { validateZeroExPayload, zeroExInterface } from "./codecs";
it("validates canonical ERC20 AllowanceHolder input and rejects token/target substitutions", () => {
    const a = vectors.addresses;
    const inner = zeroExInterface.encodeFunctionData("execute", [
        [a.router, a.token, 10n],
        ["0x12345678"],
        "0x" + "00".repeat(32),
    ]);
    const data = zeroExInterface.encodeFunctionData("exec", [
        a.settler,
        a.weth,
        100n,
        a.settler,
        inner,
    ]) as `0x${string}`;
    const options = {
        tokenIn: a.weth,
        target: a.holder,
        data,
        routerAddress: a.router,
        tokenOut: a.token,
        amountOut: 10n,
        maxInput: 100n,
        settlerAddress: a.settler,
        allowanceHolderAddress: a.holder,
        now: 1800000000n,
    };
    expect(validateZeroExPayload(options).data).toBe(data);
    expect(() => validateZeroExPayload({ ...options, tokenIn: a.token })).toThrow();
    expect(() => validateZeroExPayload({ ...options, target: a.settler })).toThrow();
    expect(() =>
        validateZeroExPayload({ ...options, data: (data + "00") as `0x${string}` })
    ).toThrow("noncanonical");
});
