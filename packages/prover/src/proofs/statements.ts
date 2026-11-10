import type { Hex } from "@invisi-labs/primitives";
import { computeWalletAuthorizationDigest, type WalletOperation } from "@invisi-labs/primitives";

const capacities = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150,
    160, 170, 180, 190,
];
function check(ok: boolean, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
function uint(value: bigint, bits: number): bigint {
    check(value >= 0n && value < 1n << BigInt(bits), `Statement value exceeds uint${bits}`);
    return value;
}

/** Check the exact statement reconstructed by the current onchain adapter. */
export function assertUserStatement(values: readonly string[], capacity: number): void {
    check(values.length === 17 + 3 * capacity, "User statement width mismatch");
    const w = values.map(BigInt),
        n = Number(w[3]),
        m = Number(w[4]),
        k = Number(w[5]);
    check(
        n >= 0 && m >= 0 && n + m > 0 && capacities.find((c) => n + m <= c) === capacity,
        "Noncanonical transact capacity"
    );
    uint(w[0]!, 64);
    uint(w[1]!, 160);
    uint(w[2]!, 160);
    check(w[1] !== 0n && w[2] !== 0n, "Zero statement context address");
    check(n === 0 ? k === 0 : k >= 1 && k <= n, "Noncanonical source count");
    for (let i = 0; i < capacity; i++) {
        const id = w[6 + i]!,
            root = w[6 + capacity + i]!;
        if (i < k) {
            uint(id, 64);
            check(
                id > 0n && root > 0n && (i === 0 || id > w[5 + i]!),
                "Noncanonical source ordering"
            );
        } else check(id === 0n && root === 0n, "Noncanonical source padding");
    }
    const at = 6 + 3 * capacity,
        slots = w.slice(6 + 2 * capacity, at);
    check(
        slots.slice(n + m).every((v) => v === 0n),
        "Noncanonical slot padding"
    );
    check(
        slots.slice(0, n + m).every((v) => v > 0n),
        "Zero statement slot"
    );
    check(new Set(slots.slice(0, n).map(String)).size === n, "Duplicate nullifier");
    check(new Set(slots.slice(n, n + m).map(String)).size === m, "Duplicate commitment");
    uint(w[at]!, 128);
    uint(w[at + 1]!, 128);
    uint(w[at + 2]!, 160);
    uint(w[at + 3]!, 128);
    uint(w[at + 4]!, 64);
    uint(w[at + 5]!, 128);
    uint(w[at + 6]!, 160);
    uint(w[at + 7]!, 160);
    uint(w[at + 8]!, 128);
    check((w[at + 7] === 0n) === (w[at + 8] === 0n), "Invalid fee context");
    check((w[at + 2] === 0n) === (w[at + 3] === 0n), "Invalid withdrawal context");
    check((w[at + 5] === 0n) === (w[at + 6] === 0n), "Invalid funding context");
    check(m > 0 || w[at + 3]! > 0n, "Missing transaction output");
    if (n === 0)
        check(m >= 2 && w[at + 5]! > 0n && w[at + 3] === 0n, "Invalid pure funding context");
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: w[0]!, protocolAddress: w[1]! },
            operation: "transact",
            capacity,
            words: w.slice(0, -2),
        })
    );
    check(
        w[at + 9] === digest >> 128n && w[at + 10] === (digest & ((1n << 128n) - 1n)),
        "Authorization digest does not match statement"
    );
}

/** Validate ordered members, common deployment and global nullifier/commitment uniqueness. */
export function assertAggregateStatement(
    values: readonly Hex[],
    count: number,
    pin: string | string[],
    capacity: number
): void {
    const mixed = Array.isArray(pin),
        caps = mixed
            ? values.slice(0, count).map((v) => Number(BigInt(v)))
            : Array(count).fill(capacity),
        pins = mixed ? pin : [pin];
    check(
        values.slice(-pins.length).every((v, i) => BigInt(v) === BigInt(pins[i]!)),
        "Aggregate inner verification key commitment mismatch"
    );
    const nullifiers = new Set<string>(),
        commitments = new Set<string>();
    let context: bigint[] | undefined,
        offset = mixed ? count : 0;
    for (let i = 0; i < count; i++) {
        const c = caps[i]!;
        check(c >= 1 && c <= (mixed ? 5 : 10), "Invalid aggregate member capacity");
        const width = 17 + 3 * c,
            member = values.slice(offset, offset + width);
        assertUserStatement(member, c);
        if (context)
            check(
                member.slice(0, 2).every((v, j) => BigInt(v) === context![j]),
                "Aggregate context mismatch"
            );
        else context = member.slice(0, 2).map(BigInt);
        const n = Number(BigInt(member[3]!)),
            m = Number(BigInt(member[4]!));
        for (let j = 0; j < n + m; j++) {
            const v = BigInt(member[6 + 2 * c + j]!).toString(),
                seen = j < n ? nullifiers : commitments;
            check(!seen.has(v), "Duplicate aggregate nullifier or commitment");
            seen.add(v);
        }
        if (mixed)
            check(
                values.slice(offset + width, offset + 32).every((v) => BigInt(v) === 0n),
                "Noncanonical mixed statement padding"
            );
        offset += mixed ? 32 : width;
    }
    check(offset + pins.length === values.length, "Aggregate statement width mismatch");
}

/** Credit adapters reconstruct this digest from the exact base business words. */
export function assertCreditStatement(values: readonly string[], name: string): void {
    const w = values.map(BigInt);
    const operation: WalletOperation =
        name === "create_credit"
            ? "create-credit"
            : name === "credit_update"
              ? "update-credit"
              : "credit-draw";
    const capacity =
        operation === "credit-draw" ? Number(name.slice("credit_draw_slots".length)) : 1;
    const feeRecipient = uint(w.at(-4)!, 160),
        feeAmount = uint(w.at(-3)!, 128);
    check((feeRecipient === 0n) === (feeAmount === 0n), "Invalid Credit fee context");
    if (operation === "credit-draw")
        check(feeAmount < w[7 + 10 * capacity]!, "Credit draw fee must leave a positive Note");
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: w[0]!, protocolAddress: w[1]! },
            operation,
            capacity,
            words: w.slice(0, -2),
        })
    );
    check(
        w.at(-2) === digest >> 128n && w.at(-1) === (digest & ((1n << 128n) - 1n)),
        "Authorization digest does not match statement"
    );
}
