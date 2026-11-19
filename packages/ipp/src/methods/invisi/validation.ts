import { ReceivingAddress } from "@invisi-labs/primitives/address";
import { invalid } from "../../core/errors";
import { object, text, integer, number, timestamp, hex, type ObjectValue } from "../../core/values";
import type { Mode } from "../../core/types";
import type { CreditTerms, Option, Request, PaymentReceipt, CreditReceipt } from "./types";

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function field(value: unknown): string {
    const s = hex(value, 32, true);
    if (BigInt(s) >= FIELD) return invalid();
    return s;
}

function network(value: unknown): void {
    if (typeof value !== "string" || !/^eip155:[1-9]\d*$/.test(value)) return invalid();
    integer(value.slice(7), 64, true);
}

function spender(value: unknown): void {
    const s = text(value);
    if (!s.startsWith("0i")) return invalid();
    try {
        ReceivingAddress.parse(s);
    } catch {
        return invalid();
    }
}

function creditTerms(value: ObjectValue, extra: string[] = []): void {
    const c = object(
        value,
        [
            "spender",
            "availableCredit",
            "unlimited",
            "singleLimit",
            "dailyLimit",
            "monthlyLimit",
            "expiresAt",
            ...extra,
        ],
        ["initialPayment"]
    );
    spender(c.spender);
    const amount = integer(c.availableCredit, 128);
    if (typeof c.unlimited !== "boolean" || (c.unlimited ? amount !== 0n : amount === 0n))
        return invalid();
    for (const k of ["singleLimit", "dailyLimit", "monthlyLimit"]) integer(c[k], 126);
    timestamp(c.expiresAt);
    if (c.initialPayment !== undefined) {
        const d = object(c.initialPayment, ["amount"]);
        integer(d.amount, 126, true);
    }
}

function option(value: ObjectValue, mode: Mode): void {
    const o = object(value, [
        "id",
        "method",
        "network",
        "asset",
        mode === "payment" ? "amount" : "credit",
    ]);
    if (o.method !== "invisi") return invalid();
    network(o.network);
    const a = object(o.asset, ["address", "symbol", "decimals"]);
    hex(a.address, 20, true);
    text(a.symbol);
    number(a.decimals, 255);
    if (mode === "payment") integer(o.amount, 128, true);
    else creditTerms(o.credit as ObjectValue);
}

function request(raw: ObjectValue): void {
    if (raw.mode === "payment") {
        if (raw.credit !== undefined) return invalid();
        const p = object(raw.payment, [
            "network",
            "protocolAddress",
            "tokenAddress",
            "amount",
            "recipient",
        ]);
        network(p.network);
        hex(p.protocolAddress, 20, true);
        hex(p.tokenAddress, 20, true);
        integer(p.amount, 128, true);
        const r = object(p.recipient, ["type", "identity"]);
        if (r.type !== "identity") return invalid();
        field(r.identity);
    } else {
        if (raw.payment !== undefined) return invalid();
        const c = raw.credit as ObjectValue;
        creditTerms(c, [
            "operation",
            "network",
            "protocolAddress",
            "tokenAddress",
            "creditSharedKey",
        ]);
        if (c.operation !== "create") return invalid();
        network(c.network);
        hex(c.protocolAddress, 20, true);
        hex(c.tokenAddress, 20, true);
        field(c.creditSharedKey);
        if (timestamp(c.expiresAt) < timestamp(raw.expiresAt)) return invalid();
    }
}

function receipt(value: unknown, mode: Mode): void {
    const credit = mode === "credit";
    const r = object(
        value,
        [
            "network",
            "protocolAddress",
            "transactionHash",
            "commitment",
            "blockNumber",
            "blockHash",
            "completedAt",
            ...(credit
                ? [
                      "creditId",
                      "creditStatus",
                      "owner",
                      "revocationShard",
                      "revocationSlot",
                      "verificationBlock",
                      "expiresAt",
                  ]
                : []),
        ],
        credit ? ["initialPayment"] : []
    );
    network(r.network);
    hex(r.protocolAddress, 20, true);
    hex(r.transactionHash, 32, true);
    field(r.commitment);
    integer(r.blockNumber, 64);
    hex(r.blockHash, 32, true);
    timestamp(r.completedAt);
    if (credit) {
        text(r.creditId);
        if (
            r.creditStatus !== "active" &&
            !(r.creditStatus === "depleted" && r.initialPayment !== undefined)
        )
            return invalid();
        if (r.initialPayment !== undefined) {
            const d = object(r.initialPayment, [
                "noteCommitment",
                "grossAmount",
                "netAmount",
                "feeAmount",
                "feeRecipient",
            ]);
            if (field(d.noteCommitment) === r.commitment) return invalid();
            const fee = integer(d.feeAmount, 126);
            if (
                integer(d.grossAmount, 126, true) !== integer(d.netAmount, 126, true) + fee ||
                (fee === 0n) !== (BigInt(hex(d.feeRecipient, 20)) === 0n)
            )
                return invalid();
        }
        hex(r.owner, 20, true);
        integer(r.revocationShard, 64);
        number(r.revocationSlot, 65535);
        timestamp(r.expiresAt);
        const b = object(r.verificationBlock, ["number", "hash", "timestamp"]);
        integer(b.number, 64);
        hex(b.hash, 32, true);
        timestamp(b.timestamp);
    }
}

function match(request: Request, option: Option): void {
    const details = request.mode === "payment" ? request.payment : request.credit;
    if (details.network !== option.network || details.tokenAddress !== option.asset.address)
        return invalid();
    if (request.mode === "payment") {
        if (!("amount" in option) || request.payment.amount !== option.amount) return invalid();
    } else {
        if (!("credit" in option)) return invalid();
        for (const key of Object.keys(option.credit) as (keyof CreditTerms)[])
            if (key !== "initialPayment" && request.credit[key] !== option.credit[key])
                return invalid();
        const a = request.credit.initialPayment,
            b = option.credit.initialPayment;
        if (!!a !== !!b || (a && b && a.amount !== b.amount)) return invalid();
    }
}

function credential(c: ObjectValue): void {
    const p = object(
        c.proof,
        ["type", "transactionHash", "commitment"],
        c.mode === "credit" ? ["owner", "revocationShard", "revocationSlot"] : []
    );
    if (p.type !== (c.mode === "payment" ? "note" : "credit_created")) return invalid();
    hex(p.transactionHash, 32, true);
    field(p.commitment);
    if (p.owner !== undefined) hex(p.owner, 20, true);
    if (p.revocationShard !== undefined) integer(p.revocationShard, 64);
    if (p.revocationSlot !== undefined) number(p.revocationSlot, 65535);
}

function matchReceipt(value: PaymentReceipt | CreditReceipt, request: Request): void {
    const details = request.mode === "payment" ? request.payment : request.credit;
    if (value.network !== details.network || value.protocolAddress !== details.protocolAddress)
        return invalid();
    if (request.mode === "credit") {
        const terms = request.credit.initialPayment,
            draw = (value as CreditReceipt).initialPayment;
        if (!!terms !== !!draw || (terms && draw && terms.amount !== draw.netAmount))
            return invalid();
    }
}
function privateValues(request: Request): string[] {
    return request.mode === "credit" ? [request.credit.creditSharedKey] : [];
}
export const invisiValidation = {
    requestFields: ["payment", "credit"],
    option,
    request,
    receipt,
    match,
    credential,
    matchReceipt,
    privateValues,
};
