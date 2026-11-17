import { invalid } from "./errors";

/** JSON.parse alone loses duplicate properties and accepts unpaired surrogate escapes. */
export function parseIppJson(text: string): unknown {
    if (text.length > 1024 * 1024) return invalid();
    let pos = 0;
    const space = () => {
        while (/\s/.test(text[pos] ?? "") && pos < text.length) pos++;
    };
    const string = (): string => {
        const start = pos++;
        while (pos < text.length) {
            const c = text[pos++];
            if (c === "\\") {
                pos++;
                continue;
            }
            if (c === '"') {
                let value: string;
                try {
                    value = JSON.parse(text.slice(start, pos)) as string;
                } catch {
                    return invalid();
                }
                for (let i = 0; i < value.length; i++) {
                    const n = value.charCodeAt(i);
                    if (n >= 0xd800 && n <= 0xdbff) {
                        const next = value.charCodeAt(++i);
                        if (!(next >= 0xdc00 && next <= 0xdfff)) return invalid();
                    } else if (n >= 0xdc00 && n <= 0xdfff) return invalid();
                }
                return value;
            }
        }
        return invalid();
    };
    const value = (depth: number): void => {
        if (depth > 64) return invalid();
        space();
        const c = text[pos];
        if (c === '"') {
            string();
            return;
        }
        if (c === "{" || c === "[") {
            pos++;
            space();
            const close = c === "{" ? "}" : "]";
            const keys = new Set<string>();
            if (text[pos] === close) {
                pos++;
                return;
            }
            while (pos < text.length) {
                if (c === "{") {
                    space();
                    if (text[pos] !== '"') return invalid();
                    const key = string();
                    if (keys.has(key)) return invalid();
                    keys.add(key);
                    space();
                    if (text[pos++] !== ":") return invalid();
                }
                value(depth + 1);
                space();
                if (text[pos] === close) {
                    pos++;
                    return;
                }
                if (text[pos++] !== ",") return invalid();
            }
            return invalid();
        }
        const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
            text.slice(pos)
        );
        if (!match) return invalid();
        pos += match[0].length;
    };
    try {
        value(0);
        space();
        if (pos !== text.length) return invalid();
        return JSON.parse(text) as unknown;
    } catch {
        return invalid();
    }
}

/** Bound response memory and reject malformed UTF-8 before JSON interpretation. */
export async function readIppResponse(response: Response): Promise<unknown> {
    const maximum = 1024 * 1024;
    const length = response.headers.get("Content-Length");
    if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) return invalid();
    if (!response.body) return invalid();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > maximum) {
                await reader.cancel();
                return invalid();
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return invalid();
    }
    return parseIppJson(text);
}
