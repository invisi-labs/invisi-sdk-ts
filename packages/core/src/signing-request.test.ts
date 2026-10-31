import { expect, it } from "vitest";
import { TypedDataEncoder, Wallet } from "ethers";
import { createSigningRequest } from "./signing-request";

it("exports JSON-safe typed data without the RPC-only EIP712Domain entry", async () => {
    const original = {
        domain: {
            name: "Test",
            version: "1",
            chainId: 97n,
            verifyingContract: "0x1111111111111111111111111111111111111111",
        },
        primaryType: "Grant",
        types: { Grant: [{ name: "amount", type: "uint256" }] },
        message: { amount: 123456789012345678901234567890n },
    };
    const request = JSON.parse(JSON.stringify(createSigningRequest(original)));
    expect(request.message.amount).toBe(original.message.amount.toString());
    expect(request.types).not.toHaveProperty("EIP712Domain");
    expect(TypedDataEncoder.hash(request.domain, request.types, request.message)).toBe(
        TypedDataEncoder.hash(original.domain, original.types, original.message)
    );
    const signer = Wallet.createRandom();
    await expect(
        signer.signTypedData(request.domain, request.types, request.message)
    ).resolves.toMatch(/^0x/);
    request.types.Grant[0].name = "other";
    expect(original.types.Grant[0]!.name).toBe("amount");
    expect(() => createSigningRequest({ ...original, primaryType: "Wrong" })).toThrow(
        /primary type/
    );
});
