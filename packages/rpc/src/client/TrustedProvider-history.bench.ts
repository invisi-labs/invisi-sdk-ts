import { bench, describe } from "vitest";
import { fixture } from "./TrustedProvider-history-fixtures";

// Measures client decoding, full RLP verification and JSON transport overhead for
// 256 headers. No network latency is simulated: the range needs one request,
// versus one unsupported-method probe plus 13 live batches in the fallback.
const numbers = Array.from({ length: 256 }, (_, i) => BigInt(i + 1));
const historical = fixture();
const live = fixture(undefined, -32601);
describe("trusted historical full headers (256 blocks; in-memory transport)", () => {
    bench(
        "historical range",
        async () => {
            await historical.reader.getBlocks(numbers);
            historical.requests.length = 0;
        },
        { time: 300, iterations: 5 }
    );
    bench(
        "unsupported method and live fallback",
        async () => {
            await live.reader.getBlocks(numbers);
            live.requests.length = 0;
        },
        { time: 300, iterations: 5 }
    );
});
