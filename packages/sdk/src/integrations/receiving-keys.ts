import {
    buildReceivingKeyMessage,
    deriveReceivingKeysFromSignature,
    type ReceivingKeyMaterial,
} from "@invisi-labs/primitives";
import { ReceivingAddress } from "@invisi-labs/primitives/address";
import { hexlify, type Eip1193Provider } from "ethers";

type ProviderListener = (value: unknown) => void;

export type ReceivingKeyProvider = Eip1193Provider & {
    on?(event: "accountsChanged" | "disconnect", listener: ProviderListener): unknown;
    removeListener?(event: "accountsChanged" | "disconnect", listener: ProviderListener): unknown;
};

export interface ReceivingKeyRequest {
    readonly ownerAddress: string;
    /** Use a specifically chosen authorized account instead of the first account. */
    readonly accountSelection?: "first" | "authorized";
    /** A saved full 0i address used to confirm recovery with the connected signer. */
    readonly expectedAddress?: string;
    readonly signal?: AbortSignal;
}

/**
 * Request one personal signature for the EOA selected in a connected provider.
 * By default the selected account is first in eth_accounts. Authorized mode
 * accepts an explicitly chosen account while its authorization remains present.
 */
export async function requestReceivingKeys(
    provider: ReceivingKeyProvider,
    { ownerAddress, expectedAddress, signal, accountSelection = "first" }: ReceivingKeyRequest
): Promise<ReceivingKeyMaterial> {
    signal?.throwIfAborted();
    const message = hexlify(buildReceivingKeyMessage(ownerAddress));
    const owner = ownerAddress.toLowerCase();
    if (expectedAddress !== undefined) {
        const expected = ReceivingAddress.parse(expectedAddress);
        if (expected.kind !== "long" || expected.ownerAddress !== owner) {
            throw new Error("saved receiving address must belong to the selected account");
        }
    }

    const isSelected = (accounts: unknown) => {
        if (!Array.isArray(accounts)) return false;
        const matchesOwner = (account: unknown) =>
            typeof account === "string" && account.toLowerCase() === owner;
        return accountSelection === "authorized"
            ? accounts.some(matchesOwner)
            : matchesOwner(accounts[0]);
    };
    const requestLifetime = new AbortController();
    const onAbort = () => requestLifetime.abort(signal?.reason);
    const onAccountsChanged = (accounts: unknown) => {
        if (!isSelected(accounts)) {
            requestLifetime.abort(new Error("selected receiving account changed"));
        }
    };
    const onDisconnect = (error: unknown) => {
        requestLifetime.abort(error ?? new Error("receiving wallet disconnected"));
    };
    const { signal: lifetime } = requestLifetime;
    const cancelled = new Promise<never>((_, reject) => {
        lifetime.addEventListener("abort", () => reject(lifetime.reason), { once: true });
    });
    const watchAccounts =
        typeof provider.on === "function" && typeof provider.removeListener === "function";
    const assertSelected = (accounts: unknown) => {
        lifetime.throwIfAborted();
        if (!isSelected(accounts)) throw new Error("selected receiving account mismatch");
    };

    try {
        signal?.addEventListener("abort", onAbort, { once: true });
        if (watchAccounts) {
            provider.on!("accountsChanged", onAccountsChanged);
            provider.on!("disconnect", onDisconnect);
        }
        assertSelected(
            await Promise.race([cancelled, provider.request({ method: "eth_accounts" })])
        );
        const signature: unknown = await Promise.race([
            cancelled,
            provider.request({ method: "personal_sign", params: [message, owner] }),
        ]);
        lifetime.throwIfAborted();
        assertSelected(
            await Promise.race([cancelled, provider.request({ method: "eth_accounts" })])
        );
        if (typeof signature !== "string") throw new Error("invalid receiving signature response");

        const keys = deriveReceivingKeysFromSignature({ ownerAddress: owner, signature });
        if (expectedAddress !== undefined && keys.getAddress() !== expectedAddress) {
            throw new Error("signature does not recover the saved receiving address");
        }
        return keys;
    } finally {
        signal?.removeEventListener("abort", onAbort);
        if (watchAccounts) {
            provider.removeListener!("accountsChanged", onAccountsChanged);
            provider.removeListener!("disconnect", onDisconnect);
        }
    }
}
