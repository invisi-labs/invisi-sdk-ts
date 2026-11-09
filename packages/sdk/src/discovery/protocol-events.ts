import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Interface, type ParamType } from "ethers";

const protocolInterface = new Interface(invisiProtocolAbi);

/** Decode only canonical protocol receipt bytes before routing events to token wallets. */
export function decodeProtocolEvent(log: { data: string; topics: readonly string[] }) {
    const decoded = protocolInterface.parseLog(log);
    if (!decoded) throw new Error("Unknown protocol receipt event");
    const encoded = protocolInterface.encodeEventLog(decoded.fragment, decoded.args);
    if (
        encoded.data.toLowerCase() !== log.data.toLowerCase() ||
        encoded.topics.length !== log.topics.length ||
        encoded.topics.some(
            (topic, index) => topic.toLowerCase() !== log.topics[index]!.toLowerCase()
        )
    )
        throw new Error("Noncanonical protocol receipt event");
    const value = (type: ParamType, item: unknown): unknown => {
        if (type.baseType === "array")
            return Array.from(item as readonly unknown[], (v) => value(type.arrayChildren!, v));
        if (type.baseType === "tuple")
            return Object.fromEntries(
                type.components!.map((t, i) => [t.name, value(t, (item as readonly unknown[])[i])])
            );
        return item;
    };
    const args = Object.fromEntries(
        decoded.fragment.inputs.map((type, i) => [type.name, value(type, decoded.args[i])])
    );
    return { eventName: decoded.name, args };
}
