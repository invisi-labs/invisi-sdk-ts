import { createSigningRequest } from "@invisi-labs/primitives";
import { encodeRevokeCreditTypedData } from "@invisi-labs/protocol";
import { getAddress, verifyTypedData } from "ethers";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { OperationPlan, TransactionRuntime } from "../operation-types";
export async function revocationSigningRequest(
    plan: OperationPlan,
    runtime: Pick<TransactionRuntime, "reader" | "options" | "preparationReads">
) {
    const params = plan.credit?.revocation;
    if (!params) throw Error("operation is not a public Credit revocation");
    const [, block] = await Promise.all([
        runtime.options.protocol.validateDeployment(
            runtime.preparationReads?.reader() ?? runtime.reader
        ),
        runtime.reader.getLatestBlockNumber().then((number) => runtime.reader.getBlock(number)),
    ]);
    if (block.timestamp > params.deadline) throw Error("revocation authorization expired");
    const request = createSigningRequest(
        encodeRevokeCreditTypedData({ ...plan.context, now: block.timestamp }, params)
    );
    if ((await runtime.reader.getBlock(block.number)).hash !== block.hash)
        throw Error("canonical revocation block changed");
    return request;
}
export async function acceptRevocationSignature(
    plan: OperationPlan,
    signature: Hex,
    runtime: Pick<TransactionRuntime, "reader" | "options" | "preparationReads">
) {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) throw Error("invalid revocation signature");
    const request = await revocationSigningRequest(plan, runtime),
        owner = plan.credit!.revocation!.owner;
    let valid = false;
    try {
        valid =
            getAddress(
                verifyTypedData(request.domain, request.types, request.message, signature)
            ) === getAddress(owner);
    } catch {}
    if (!valid && runtime.options.fundingVerifier)
        valid = await runtime.options.fundingVerifier.verifyTypedData({
            ...request,
            address: owner,
            signature,
        });
    if (!valid) throw Error("invalid owner revocation signature");
    return signature;
}
