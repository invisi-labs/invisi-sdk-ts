import { expect, it } from "vitest";
import { prepareInvisiRequest } from "./prepare";
import { parsePaymentRequest } from "../../index";
import { address, hash, origin, protocolAddress, request } from "../../testing/fixtures";
import { NoteOutput } from "@invisi-labs/sdk/note";
const now = () => Date.parse("2026-11-17T08:03:00Z");
const protocol = { context: { chainId: 8453n, protocolAddress: protocolAddress as `0x${string}` } };
it("converts an IPP payment into an actual identity output and prepares without signing or broadcasting", async () => {
    const calls: unknown[] = [];
    const target = {
        protocol,
        prepareTransfer: async (options: unknown) => {
            calls.push(options);
            return "prepared";
        },
    };
    expect(
        await prepareInvisiRequest(parsePaymentRequest(request(), origin), target, { now })
    ).toBe("prepared");
    expect(calls).toHaveLength(1);
    const args = calls[0] as { outputs: NoteOutput[]; tokenAddress: string; deadline: bigint };
    expect(args.tokenAddress).toBe(address);
    expect(args.deadline).toBe(1794903600n);
    expect(args.outputs[0]).toBeInstanceOf(NoteOutput);
    expect(args.outputs[0]!.identity).toBe(hash);
    expect(args.outputs[0]!.amount).toBe(10000000n);
});
it("converts credit creation terms and passes the exact original shared key", async () => {
    let input: unknown;
    const target = {
        protocol,
        prepareCreateCredit: async (options: unknown) => {
            input = options;
            return "credit";
        },
    };
    expect(
        await prepareInvisiRequest(parsePaymentRequest(request("credit"), origin), target, { now })
    ).toBe("credit");
    expect(input).toMatchObject({
        creditSharedKey: BigInt(hash),
        availableCredit: 1000000000n,
        unlimited: false,
        singleLimit: 10000000n,
        dailyLimit: 50000000n,
        monthlyLimit: 300000000n,
    });
});
it("rejects a chain or deployment mismatch before wallet preparation", async () => {
    let calls = 0;
    const target = {
        protocol: { context: { ...protocol.context, chainId: 1n } },
        prepareTransfer: async () => {
            calls++;
        },
    };
    await expect(
        prepareInvisiRequest(parsePaymentRequest(request(), origin), target, { now })
    ).rejects.toThrow();
    expect(calls).toBe(0);
});
it("never repeats wallet execution for expired, processing or terminal requests", async () => {
    let calls = 0;
    const target = {
        protocol,
        prepareTransfer: async () => {
            calls++;
        },
    };
    for (const status of ["processing", "succeeded", "failed"] as const) {
        const r = { ...request(), status, failureReason: status === "failed" ? "expired" : null };
        await expect(
            prepareInvisiRequest(parsePaymentRequest(r, origin), target, { now })
        ).rejects.toThrow();
    }
    await expect(
        prepareInvisiRequest(parsePaymentRequest(request(), origin), target, {
            now: () => Date.parse("2026-11-17T09:00:00Z"),
        })
    ).rejects.toThrow();
    expect(calls).toBe(0);
});
