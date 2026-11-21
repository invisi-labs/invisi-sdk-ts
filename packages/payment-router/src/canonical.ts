import {
    AbiCoder,
    Interface,
    TypedDataEncoder,
    ZeroAddress,
    ZeroHash,
    Signature,
    id,
    keccak256,
    zeroPadValue,
    getAddress,
    verifyAuthorization,
    toQuantity,
    type Provider,
    type Authorization,
    type Signer,
} from "ethers";
import type { Address, Hex, TransactRequest } from "@invisi-labs/protocol/contracts";
import type { TransactionCall } from "@invisi-labs/protocol";
import { paymentRouterAbi, paymentRouterAccountAbi } from "./canonical-abi";
import { coreInterface } from "./core-payment";
import { address, check, hex, same, uint } from "./validation";
import { validateV3Path } from "./codecs";

const router = new Interface(paymentRouterAbi);
const account = new Interface(paymentRouterAccountAbi);
const coder = AbiCoder.defaultAbiCoder();
const nativeInputs = router.getFunction("payNative")!.inputs;
const token = new Interface([
    "function allowance(address owner,address spender) view returns(uint256)",
    "function approve(address spender,uint256 value) returns(bool)",
]);
export enum PaymentMode {
    DirectNative,
    DirectToken,
    RelayedToken,
    SponsoredNative,
}
export enum RouteChannel {
    None,
    UniswapV3,
    ZeroEx,
}
export interface PaymentRoute {
    channel: RouteChannel;
    path: Hex;
    target: Address;
    data: Hex;
}
export interface PaymentIntent {
    payer: Address;
    tokenIn: Address;
    amountInMaximum: bigint;
    refundRecipient: Address;
    relayer: Address;
    nonce: bigint;
    deadline: bigint;
    coreRequestHash: Hex;
    routeHash: Hex;
    mode: PaymentMode;
}
export interface InputPermit {
    deadline: bigint;
    v: number;
    r: Hex;
    s: Hex;
}
export const EMPTY_INPUT_PERMIT: Readonly<InputPermit> = Object.freeze({
    deadline: 0n,
    v: 0,
    r: ZeroHash as Hex,
    s: ZeroHash as Hex,
});
export function noSwapRoute(): PaymentRoute {
    return { channel: RouteChannel.None, path: "0x", target: ZeroAddress as Address, data: "0x" };
}
export function hashCoreRequest(proof: Hex, request: TransactRequest): Hex {
    return hex(keccak256(coder.encode(["bytes32", nativeInputs[1]!], [keccak256(proof), request])));
}
export function hashRoute(route: PaymentRoute): Hex {
    return hex(keccak256(coder.encode([nativeInputs[3]!], [route])));
}
export function buildPaymentIntent(
    fields: Omit<PaymentIntent, "coreRequestHash" | "routeHash">,
    proof: Hex,
    request: TransactRequest,
    route: PaymentRoute
): PaymentIntent {
    return {
        ...fields,
        coreRequestHash: hashCoreRequest(proof, request),
        routeHash: hashRoute(route),
    };
}
const intentTypes = {
    Intent: nativeInputs[2]!.components!.map(({ name, type }) => ({ name, type })),
};
export function intentTypedData(chainId: bigint, routerAddress: Address, intent: PaymentIntent) {
    return {
        domain: {
            name: "PaymentRouter",
            version: "1",
            chainId,
            verifyingContract: address(routerAddress),
        },
        types: structuredClone(intentTypes),
        primaryType: "Intent" as const,
        message: { ...intent },
    };
}
export function hashPaymentIntent(...args: Parameters<typeof intentTypedData>): Hex {
    const { domain, types, message } = intentTypedData(...args);
    return hex(TypedDataEncoder.hash(domain, types, message));
}
export async function signPaymentIntent(
    signer: Signer,
    chainId: bigint,
    routerAddress: Address,
    intent: PaymentIntent
): Promise<Hex> {
    const { domain, types, message } = intentTypedData(chainId, routerAddress, intent);
    check(same(await signer.getAddress(), intent.payer), "intent signer mismatch");
    return hex(await signer.signTypedData(domain, types, message));
}
export function inputApproval(
    tokenIn: Address,
    routerAddress: Address,
    amount: bigint
): TransactionCall {
    return {
        to: address(tokenIn),
        value: 0n,
        data: hex(
            token.encodeFunctionData("approve", [
                address(routerAddress),
                uint(amount, 256, "approval"),
            ])
        ),
    };
}
export async function inputAllowance(
    provider: Provider,
    tokenIn: Address,
    payer: Address,
    routerAddress: Address
): Promise<bigint> {
    const result = await provider.call({
        to: address(tokenIn),
        data: token.encodeFunctionData("allowance", [address(payer), address(routerAddress)]),
    });
    return token.decodeFunctionResult("allowance", result)[0];
}
export function inputPermitTypedData(
    domain: { name: string; version: string; chainId: bigint; verifyingContract: Address },
    payer: Address,
    routerAddress: Address,
    amount: bigint,
    nonce: bigint,
    deadline: bigint
) {
    return {
        domain: { ...domain },
        primaryType: "Permit" as const,
        types: {
            Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        },
        message: {
            owner: address(payer),
            spender: address(routerAddress),
            value: amount,
            nonce,
            deadline,
        },
    };
}
export function signedInputPermit(deadline: bigint, signature: Hex): InputPermit {
    const { v, r, s } = Signature.from(signature);
    return { deadline, v, r: hex(r), s: hex(s) };
}
export interface RouterPayment {
    routerAddress: Address;
    wethAddress: Address;
    proof: Hex;
    request: TransactRequest;
    intent: PaymentIntent;
    route: PaymentRoute;
    permit?: InputPermit;
    signature?: Hex;
}
export function buildRouterPayment(payment: RouterPayment): TransactionCall {
    const { routerAddress, proof, request, intent, route } = payment;
    const native =
        intent.mode === PaymentMode.DirectNative || intent.mode === PaymentMode.SponsoredNative;
    const sponsored =
        intent.mode === PaymentMode.RelayedToken || intent.mode === PaymentMode.SponsoredNative;
    check(
        native ||
            intent.mode === PaymentMode.DirectToken ||
            intent.mode === PaymentMode.RelayedToken,
        "invalid payment mode"
    );
    check(
        native === same(intent.tokenIn, ZeroAddress) &&
            sponsored !== same(intent.relayer, ZeroAddress),
        "mode/input or relayer mismatch"
    );
    check(
        !same(address(intent.payer), routerAddress) &&
            !same(address(intent.refundRecipient), routerAddress),
        "invalid payer or refund recipient"
    );
    const f = request.funding,
        p = request.params;
    check(
        same(f.payer, routerAddress) &&
            f.sigNonce === 0n &&
            f.deadline === 0n &&
            f.signature === "0x" &&
            f.permit.deadline === 0n &&
            f.permit.v === 0 &&
            BigInt(f.permit.r) === 0n &&
            BigInt(f.permit.s) === 0n,
        "invalid Core funding authorization"
    );
    uint(f.amount, 128, "Core funding", true);
    check(
        p.sources.length === 0 &&
            p.nullifiers.length === 0 &&
            p.noteCommitments.length > 0 &&
            same(p.withdrawalAddress, ZeroAddress) &&
            p.withdrawalAmount === 0n &&
            (p.feeAmount ?? 0n) <= f.amount,
        "invalid Core funding parameters"
    );
    uint(intent.amountInMaximum, 256, "input budget", true);
    check(
        intent.coreRequestHash.toLowerCase() === hashCoreRequest(proof, request) &&
            intent.routeHash.toLowerCase() === hashRoute(route),
        "intent hash mismatch"
    );
    uint(intent.nonce, 256, "Router nonce");
    uint(intent.deadline, 256, "intent deadline");
    check(intent.deadline <= p.deadline, "intent outlives Core request");
    const input = native ? address(payment.wethAddress) : address(intent.tokenIn);
    if (route.channel === RouteChannel.None) {
        check(
            same(input, p.token) &&
                intent.amountInMaximum >= f.amount &&
                route.path === "0x" &&
                route.data === "0x" &&
                same(route.target, ZeroAddress),
            "invalid no-swap route"
        );
    } else if (route.channel === RouteChannel.UniswapV3) {
        check(
            !same(input, p.token) && route.data === "0x" && same(route.target, ZeroAddress),
            "invalid V3 route"
        );
        validateV3Path(route.path, input, p.token);
    } else {
        check(
            route.channel === RouteChannel.ZeroEx &&
                !same(input, p.token) &&
                route.path === "0x" &&
                !same(route.target, ZeroAddress) &&
                route.data !== "0x",
            "invalid 0x route"
        );
    }
    const args: unknown[] = [proof, request, intent, route];
    if (!native) args.push(payment.permit ?? EMPTY_INPUT_PERMIT);
    else check(!payment.permit, "native payments cannot carry a permit");
    if (intent.mode === PaymentMode.RelayedToken) {
        check(payment.signature !== undefined, "missing intent signature");
        args.push(payment.signature);
    } else check(!payment.signature, "unexpected intent signature");
    return {
        to: address(routerAddress),
        value: native ? intent.amountInMaximum : 0n,
        data: hex(
            router.encodeFunctionData(
                native ? "payNative" : sponsored ? "payTokenFor" : "payToken",
                args
            )
        ),
    };
}
export interface NativeAccountPayment {
    chainId: bigint;
    implementation: Address;
    payer: Address;
    routerCodeHash: Hex;
    routerCall: TransactionCall;
    nonce: bigint;
    deadline: bigint;
    relayer: Address;
}
export function nativePaymentTypedData(p: NativeAccountPayment) {
    address(p.implementation);
    address(p.payer);
    address(p.relayer);
    address(p.routerCall.to);
    uint(p.chainId, 256, "chain ID", true);
    uint(p.nonce, 256, "account action nonce");
    uint(p.deadline, 256, "account deadline");
    check(hex(p.routerCodeHash).length === 66, "invalid Router code hash");
    const [, , i] = router.decodeFunctionData("payNative", p.routerCall.data);
    check(
        i.mode === 3n &&
            same(i.payer, p.payer) &&
            same(i.relayer, address(p.relayer)) &&
            same(i.tokenIn, ZeroAddress) &&
            i.amountInMaximum === p.routerCall.value,
        "invalid sponsored native call"
    );
    return {
        domain: {
            name: "PaymentRouterAccount",
            version: "1",
            chainId: p.chainId,
            verifyingContract: address(p.payer),
            salt: zeroPadValue(address(p.implementation), 32),
        },
        primaryType: "NativePayment" as const,
        types: {
            NativePayment: [
                { name: "routerCalldataHash", type: "bytes32" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
                { name: "relayer", type: "address" },
                { name: "router", type: "address" },
                { name: "routerCodeHash", type: "bytes32" },
            ],
        },
        message: {
            routerCalldataHash: keccak256(p.routerCall.data),
            value: p.routerCall.value,
            nonce: p.nonce,
            deadline: p.deadline,
            relayer: p.relayer,
            router: p.routerCall.to,
            routerCodeHash: p.routerCodeHash,
        },
    };
}
export function hashNativePayment(p: NativeAccountPayment): Hex {
    const { domain, types, message } = nativePaymentTypedData(p);
    return hex(TypedDataEncoder.hash(domain, types, message));
}
export async function signNativePayment(signer: Signer, p: NativeAccountPayment): Promise<Hex> {
    const { domain, types, message } = nativePaymentTypedData(p);
    check(same(await signer.getAddress(), domain.verifyingContract), "account signer mismatch");
    return hex(await signer.signTypedData(domain, types, message));
}
export function buildAccountPayment(p: NativeAccountPayment, signature: Hex): TransactionCall {
    nativePaymentTypedData(p);
    return {
        to: address(p.payer),
        value: 0n,
        data: hex(
            account.encodeFunctionData("executeNativePayment", [
                p.routerCall.data,
                p.routerCall.value,
                p.nonce,
                p.deadline,
                p.relayer,
                signature,
            ])
        ),
    };
}
export function delegationRequest(
    chainId: bigint,
    implementation: Address,
    nonce: number,
    existingCode: Hex
) {
    check(existingCode === "0x", "account already has code or an active delegation");
    check(Number.isSafeInteger(nonce) && nonce >= 0, "invalid authorization nonce");
    return {
        chainId: uint(chainId, 256, "chain ID", true),
        address: address(implementation),
        nonce,
    };
}
export function validateDelegation(
    authorization: Authorization,
    payer: Address,
    implementation: Address,
    chainId: bigint,
    nonce: bigint
) {
    check(
        same(authorization.address, implementation) &&
            authorization.chainId === chainId &&
            chainId > 0n &&
            authorization.nonce === nonce &&
            same(verifyAuthorization(authorization, authorization.signature), payer),
        "delegation authorization mismatch"
    );
}
export async function simulateOuterPayment(
    provider: Provider,
    sender: Address,
    call: TransactionCall,
    authorizationList?: Authorization[]
) {
    const tx = {
        ...call,
        from: address(sender),
        ...(authorizationList?.length ? { type: 4, authorizationList } : {}),
    };
    const [result, gasEstimate] = await Promise.all([provider.call(tx), provider.estimateGas(tx)]);
    return { spent: coder.decode(["uint256"], result)[0] as bigint, gasEstimate };
}
export function relayEnvelope(
    coreCalldata: Hex,
    outer: TransactionCall,
    authorizationList?: Authorization[]
) {
    check(outer.value === 0n, "relay outer value must be zero");
    address(outer.to);
    let inner = outer.data;
    let accountPayer: string | undefined;
    if (inner.slice(0, 10) === account.getFunction("executeNativePayment")!.selector) {
        const args = account.decodeFunctionData("executeNativePayment", inner);
        check(
            account.encodeFunctionData("executeNativePayment", args).toLowerCase() ===
                inner.toLowerCase(),
            "noncanonical account calldata"
        );
        inner = args[0];
        accountPayer = outer.to;
        const [, , intent] = router.decodeFunctionData("payNative", inner);
        check(
            intent.mode === 3n &&
                same(intent.payer, outer.to) &&
                same(intent.tokenIn, ZeroAddress) &&
                intent.amountInMaximum === args[1] &&
                same(intent.relayer, address(args[4])),
            "invalid native relay"
        );
        check((authorizationList?.length ?? 0) <= 1, "unexpected delegation authorizations");
        for (const auth of authorizationList ?? [])
            check(
                same(verifyAuthorization(auth, auth.signature), outer.to),
                "authorization payer mismatch"
            );
    } else {
        check(
            inner.slice(0, 10) === router.getFunction("payTokenFor")!.selector &&
                !authorizationList?.length,
            "invalid token relay"
        );
    }
    const decoded = router.parseTransaction({ data: inner });
    check(
        decoded &&
            router.encodeFunctionData(decoded.name, decoded.args).toLowerCase() ===
                inner.toLowerCase(),
        "noncanonical Router calldata"
    );
    if (!accountPayer)
        check(
            decoded.args[2].mode === 2n && !same(decoded.args[2].relayer, ZeroAddress),
            "invalid token relay mode"
        );
    check(
        decoded &&
            coreInterface
                .encodeFunctionData("transact", [decoded.args[0], decoded.args[1]])
                .toLowerCase() === coreCalldata.toLowerCase(),
        "embedded Core calldata mismatch"
    );
    return {
        data: coreCalldata,
        router: {
            to: getAddress(outer.to),
            data: outer.data,
            value: "0" as const,
            ...(authorizationList?.length
                ? {
                      authorizationList: authorizationList.map(
                          ({ address, chainId, nonce, signature }) => ({
                              address,
                              chainId: toQuantity(chainId),
                              nonce: toQuantity(nonce),
                              yParity: toQuantity(signature.yParity),
                              r: toQuantity(signature.r),
                              s: toQuantity(signature.s),
                          })
                      ),
                  }
                : {}),
        },
    };
}

/** Quote identity used by the Broadcaster for the complete outer transaction. */
export const PAYMENT_ROUTER_ENVELOPE_HASH_FORMAT = "payment-router-envelope-v1" as const;
export function hashRelayEnvelope(
    chainId: bigint,
    core: Address,
    outer: TransactionCall,
    authorizationList: Authorization[] = []
): Hex {
    uint(chainId, 256, "chain ID", true);
    check(outer.value === 0n && hex(outer.data).length >= 10, "invalid relay envelope");
    const authorizations = authorizationList.map((a) => {
        uint(a.chainId, 256, "authorization chain ID");
        uint(a.nonce, 64, "authorization nonce");
        return [
            a.chainId,
            address(a.address),
            a.nonce,
            a.signature.yParity,
            a.signature.r,
            a.signature.s,
        ];
    });
    const authHash = keccak256(
        coder.encode(
            [
                "tuple(uint256 chainId,address delegate,uint64 nonce,uint8 yParity,bytes32 r,bytes32 s)[]",
            ],
            [authorizations]
        )
    );
    return hex(
        keccak256(
            coder.encode(
                ["bytes32", "uint256", "address", "address", "uint256", "bytes32", "bytes32"],
                [
                    id(
                        "InvisiPaymentRouterEnvelope(uint256 chainId,address core,address to,uint256 value,bytes32 dataHash,bytes32 authorizationListHash)"
                    ),
                    chainId,
                    address(core),
                    address(outer.to),
                    0n,
                    keccak256(outer.data),
                    authHash,
                ]
            )
        )
    );
}

/** Inspect the pinned implementation and current EIP-7702 state without changing account configuration. */
export async function prepareNativeAccountPayment(
    provider: Provider,
    input: Omit<NativeAccountPayment, "nonce" | "routerCodeHash">,
    options: { implementationCodeHash?: Hex; undelegatedNonce?: bigint } = {}
): Promise<{
    payment: NativeAccountPayment;
    delegationNeeded: boolean;
    authorizationRequest?: ReturnType<typeof delegationRequest>;
}> {
    check((await provider.getNetwork()).chainId === input.chainId, "account chain mismatch");
    const [implementationCode, existingCode, routerCode] = await Promise.all([
        provider.getCode(input.implementation),
        provider.getCode(input.payer),
        provider.getCode(input.routerCall.to),
    ]);
    check(implementationCode !== "0x" && routerCode !== "0x", "missing account or Router code");
    if (options.implementationCodeHash)
        check(
            keccak256(implementationCode).toLowerCase() ===
                options.implementationCodeHash.toLowerCase(),
            "account implementation code hash mismatch"
        );
    const expectedDelegation = "0xef0100" + input.implementation.slice(2).toLowerCase();
    check(
        existingCode === "0x" || existingCode.toLowerCase() === expectedDelegation,
        "account already has another implementation"
    );
    const [pinnedRouter, pinnedCodeHash] = await Promise.all(
        ["router", "routerCodeHash"].map(
            async (name) =>
                account.decodeFunctionResult(
                    name,
                    await provider.call({
                        to: input.implementation,
                        data: account.encodeFunctionData(name),
                    })
                )[0]
        )
    );
    const routerCodeHash = hex(keccak256(routerCode));
    check(
        same(pinnedRouter, input.routerCall.to) && pinnedCodeHash.toLowerCase() === routerCodeHash,
        "account Router deployment mismatch"
    );
    const delegationNeeded = existingCode === "0x";
    check(
        !delegationNeeded || options.undelegatedNonce !== undefined,
        "supply the previously known account nonce for an undelegated account"
    );
    const nonce = delegationNeeded
        ? uint(options.undelegatedNonce!, 256, "account action nonce")
        : (account.decodeFunctionResult(
              "nonce",
              await provider.call({ to: input.payer, data: account.encodeFunctionData("nonce") })
          )[0] as bigint);
    const payment = { ...input, nonce, routerCodeHash };
    nativePaymentTypedData(payment);
    return {
        payment,
        delegationNeeded,
        ...(delegationNeeded
            ? {
                  authorizationRequest: delegationRequest(
                      input.chainId,
                      input.implementation,
                      await provider.getTransactionCount(input.payer, "pending"),
                      hex(existingCode)
                  ),
              }
            : {}),
    };
}
