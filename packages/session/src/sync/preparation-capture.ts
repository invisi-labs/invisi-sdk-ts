import type { CanonicalBlock, Membership } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { preparationReadKey } from "@invisi-labs/sdk/session-support";

const reusable = new Set([
    "getCode",
    "getProtocolVersion",
    "getProtocolAddressRegistry",
    "getCreditStatus",
    "isKnownRoot",
    "isSpent",
]);
function canonical(value: unknown): unknown {
    if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, canonical(item)])
        );
    return value;
}
function key(method: string, args: unknown[]) {
    // Tree roots, nullifiers and grant statuses belong to the deployment, not a token context.
    if (["getMembership", "isSpent", "isKnownRoot", "getCreditStatus"].includes(method)) {
        const context = args[0] as { chainId: bigint; protocolAddress: Hex };
        args = [
            { chainId: context.chainId, protocolAddress: context.protocolAddress },
            ...args.slice(1),
        ];
    }
    return preparationReadKey(method, args.map(canonical));
}

/** Transient authenticated public facts; owned records alone are copied into private storage. */
export class PreparationCapture {
    anchor?: CanonicalBlock;
    readonly #values = new Map<string, unknown>();
    readonly #memberships = new Map<string, Membership>();
    remember(method: string, args: unknown[], value: unknown) {
        const id = key(method, args);
        this.#values.delete(id);
        this.#values.set(id, structuredClone(value));
        if (this.#values.size > 8192) this.#values.delete(this.#values.keys().next().value!);
    }
    rememberMembership(
        input: { treeId: bigint; leafIndex: number; commitment: Hex },
        proof: Membership
    ) {
        const id = `${input.treeId}:${input.leafIndex}:${input.commitment}`;
        this.#memberships.delete(id);
        this.#memberships.set(id, structuredClone(proof));
        if (this.#memberships.size > 2048)
            this.#memberships.delete(this.#memberships.keys().next().value!);
    }
    membership(input: { treeId: bigint; leafIndex: number; commitment: Hex }) {
        return structuredClone(
            this.#memberships.get(`${input.treeId}:${input.leafIndex}:${input.commitment}`)
        );
    }
    reader<T extends object>(target: T, reuse = false, includeCode = true): T {
        return new Proxy(target, {
            get: (object, method: string) => {
                const fn = Reflect.get(object, method, object);
                if (
                    typeof fn !== "function" ||
                    !reusable.has(method) ||
                    (!includeCode &&
                        ["getCode", "getProtocolVersion", "getProtocolAddressRegistry"].includes(
                            method
                        ))
                )
                    return typeof fn === "function" ? fn.bind(object) : fn;
                return async (...args: unknown[]) => {
                    if (method === "isSpent") {
                        const [context, nullifiers, block] = args as [
                            unknown,
                            Hex[],
                            CanonicalBlock,
                        ];
                        const keys = nullifiers.map((n) => key(method, [context, [n], block]));
                        const retained = new Map(
                            keys
                                .filter((k) => this.#values.has(k))
                                .map((k) => [k, this.#values.get(k) as boolean])
                        );
                        const missing = new Map<string, Hex>();
                        nullifiers.forEach((n, index) => {
                            if (!reuse || !this.#values.has(keys[index]!))
                                missing.set(keys[index]!, n);
                        });
                        if (missing.size) {
                            const words = [...missing.values()];
                            const values = (await fn.apply(object, [
                                context,
                                words,
                                block,
                            ])) as boolean[];
                            if (
                                values.length !== words.length ||
                                values.some((v) => typeof v !== "boolean")
                            )
                                throw Error("invalid spent capture response");
                            words.forEach((n, i) =>
                                this.remember(method, [context, [n], block], values[i])
                            );
                            // Build from the complete response, even when it exceeds retention limits.
                            const resolved = new Map(
                                [...missing.keys()].map((k, i) => [k, values[i]!])
                            );
                            return keys.map((k) =>
                                resolved.has(k) ? resolved.get(k)! : retained.get(k)!
                            );
                        }
                        return keys.map((k) => this.#values.get(k) as boolean);
                    }
                    const id = key(method, args);
                    if (reuse && this.#values.has(id)) return structuredClone(this.#values.get(id));
                    const result = await fn.apply(object, args);
                    if (
                        method === "getCreditStatus" &&
                        result !== 0 &&
                        result !== 1 &&
                        result !== 2
                    )
                        throw Error("invalid Credit status capture response");
                    this.remember(method, args, result);
                    return result;
                };
            },
        });
    }
}
export function createPreparationCapture(): PreparationCapture | undefined {
    return new PreparationCapture();
}

const historyCaptures = new WeakMap<object, PreparationCapture>();
export function preparationHistoryCapture(history: object) {
    return historyCaptures.get(history);
}
export function registerPreparationHistoryCapture(
    history: object,
    capture: PreparationCapture | undefined
) {
    if (capture) historyCaptures.set(history, capture);
}
