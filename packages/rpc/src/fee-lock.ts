import { getAddress, verifyTypedData } from "ethers";
import { broadcasterQuoteDomain, type BroadcasterTrust } from "./broadcaster";
export const broadcasterFeeLockModel = "core-gas-v1.3.4";
export const broadcasterFeeLockTypes = {
    FeeLock: [
        { name: "token", type: "address" },
        { name: "feeRecipient", type: "address" },
        ...[
            "numerator",
            "denominator",
            "gasPrice",
            "markupBps",
            "gasMarginBps",
            "maxGas",
            "deadline",
        ].map((name) => ({ name, type: "uint256" })),
        { name: "model", type: "string" },
    ],
};
export interface BroadcasterFeeLock {
    token: string;
    feeRecipient: string;
    numerator: string;
    denominator: string;
    gasPrice: string;
    markupBps: string;
    gasMarginBps: string;
    maxGas: string;
    deadline: string;
    model: string;
}
export interface SignedBroadcasterFeeLock {
    lock: BroadcasterFeeLock;
    signature: string;
}
export function verifyBroadcasterFeeLock(
    ticket: SignedBroadcasterFeeLock,
    trust: BroadcasterTrust,
    token: string,
    recipient: string,
    now = Math.floor(Date.now() / 1000)
): void {
    const lock = ticket?.lock;
    if (
        !lock ||
        Object.keys(lock).length !== 10 ||
        Object.keys(lock).some((k) => !broadcasterFeeLockTypes.FeeLock.some((f) => f.name === k)) ||
        lock.model !== broadcasterFeeLockModel ||
        trust.chainId <= 0n ||
        BigInt(getAddress(trust.protocol)) === 0n ||
        BigInt(getAddress(trust.signer)) === 0n ||
        getAddress(lock.token) !== getAddress(token) ||
        BigInt(getAddress(token)) === 0n ||
        getAddress(lock.feeRecipient) !== getAddress(recipient) ||
        BigInt(getAddress(recipient)) === 0n
    )
        throw Error("Invalid broadcaster fee lock");
    for (const [i, name] of [
        "numerator",
        "denominator",
        "gasPrice",
        "markupBps",
        "gasMarginBps",
        "maxGas",
        "deadline",
    ].entries()) {
        const value = lock[name as keyof BroadcasterFeeLock];
        if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 78)
            throw Error("Invalid broadcaster fee lock bounds");
        const n = BigInt(value);
        if (
            n >= 1n << 256n ||
            ((i < 3 || i >= 5) && n === 0n) ||
            ((i === 3 || i === 4) && n > 100000n) ||
            (i >= 5 && n >= 1n << 63n)
        )
            throw Error("Invalid broadcaster fee lock bounds");
    }
    if (BigInt(lock.deadline) <= BigInt(now)) throw Error("FEE_LOCK_EXPIRED");
    if (
        getAddress(
            verifyTypedData(
                broadcasterQuoteDomain(trust),
                broadcasterFeeLockTypes,
                lock,
                ticket.signature
            )
        ) !== getAddress(trust.signer)
    )
        throw Error("Untrusted broadcaster fee lock");
}
