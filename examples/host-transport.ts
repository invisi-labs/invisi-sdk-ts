import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createNativeWalletClient } from "@invisi-labs/native-wallet";

// Only transport framing is shared; each scenario retains its business steps.
export async function readHostJson(): Promise<unknown> {
    const terminal = createInterface({ input: stdin, output: stdout, terminal: true });
    try {
        return JSON.parse(await terminal.question("Paste one host response JSON line: "));
    } finally {
        terminal.close();
    }
}
// Host responses remain explicit arrays; the client validates IDs, owners, shape, and size.
export const nativeWallet = createNativeWalletClient({
    async executeWalletRequests(json) {
        console.log("Native wallet request batch:", json);
        return JSON.stringify(await readHostJson());
    },
});
export function json(value: unknown): string {
    return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));
}
export function hostSignature(value: unknown, id: string): `0x${string}` {
    if (
        !Array.isArray(value) ||
        value.length !== 1 ||
        value[0]?.id !== id ||
        typeof value[0]?.signature !== "string" ||
        !/^0x[0-9a-fA-F]+$/.test(value[0].signature)
    ) {
        throw Error("Invalid host EVM signature response");
    }
    return value[0].signature as `0x${string}`;
}
