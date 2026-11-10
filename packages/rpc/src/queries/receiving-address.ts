import type { Hex } from "@invisi-labs/primitives";
import { ReceivingAddress } from "@invisi-labs/primitives";
import { getBytes } from "ethers";
import { type ProtocolDeployment } from "../deployment/deployment";
import { invalid } from "../transport/errors";
import type { CanonicalBlock, RegisteredReceivingAddress } from "../types";
import { hash, integer, object } from "../validation/values";
import type { RpcRequest } from "./context";
export async function getReceivingAddress(
    deployment: Readonly<ProtocolDeployment>,
    rpc: RpcRequest,
    owner: string,
    options: { signal?: AbortSignal } = {}
): Promise<RegisteredReceivingAddress | null> {
    let identity: Hex;
    try {
        identity = ReceivingAddress.parse(owner).ownerAddress;
        if (!/^0x[\da-f]{40}$/i.test(owner)) invalid("Expected an EVM owner address");
    } catch {
        return invalid("Invalid receiving-address owner");
    }
    const registry = deployment.registry;
    if (!registry) invalid("Deployment has no receiving-key registry");
    const raw = await rpc("invisi_getReceivingAddress", [identity], options.signal);
    if (raw === null) return null;
    const value = object(raw);
    if (
        typeof value.ownerAddress !== "string" ||
        value.ownerAddress.toLowerCase() !== identity.toLowerCase()
    )
        invalid("RPC receiving-address identity mismatch");
    let receivingAddress: string;
    try {
        receivingAddress = ReceivingAddress.from({
            ownerAddress: identity,
            viewingPublicKey: getBytes(value.viewingPublicKey as string),
            clueKey: getBytes(value.clueKey as string),
        }).toString();
    } catch {
        return invalid("Invalid RPC receiving keys");
    }
    const reference = object(value.block);
    const block: CanonicalBlock = {
        number: integer(reference.number),
        hash: hash(reference.hash),
        parentHash: hash(reference.parentHash),
        timestamp: integer(reference.timestamp),
    };
    if (block.number < registry!.fromBlock) invalid("Registry index predates deployment");
    return { receivingAddress, nonce: integer(value.nonce), block };
}
