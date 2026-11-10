import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function readHostJson(): Promise<unknown> {
    const terminal = createInterface({ input: stdin, output: stdout, terminal: true });
    try {
        return JSON.parse(await terminal.question("Paste one public recovery record JSON line: "));
    } finally {
        terminal.close();
    }
}
export function json(value: unknown): string {
    return JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item));
}
