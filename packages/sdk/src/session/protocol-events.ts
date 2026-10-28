import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Interface, type Result } from "ethers";

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
    const args = decoded.args.toObject(true);
    // Preserve empty protocol arrays: ethers toObject(true) represents an empty Result as {}.
    for (const key of [
        "tokens",
        "commitments",
        "nullifiers",
        "outputCommitments",
        "leafIndices",
        "remainderLeafIndices",
    ]) {
        const values = decoded.args.getValue(key) as Result | undefined;
        if (values) args[key] = values.toArray(true);
    }
    for (const key of ["sources", "deliveries"]) {
        const values = decoded.args.getValue(key) as Result[] | undefined;
        if (values) args[key] = values.map((value) => value.toObject(true));
    }
    const params = decoded.args.getValue("params") as Result | undefined;
    if (params) {
        const source = (params.getValue("creation") as Result | undefined) ?? params;
        const target = params.getValue("creation") ? args.params.creation : args.params;
        for (const key of ["nullifiers", "remainderCommitments", "expiries", "recoveryAmounts"]) {
            const values = source.getValue(key) as Result | undefined;
            if (values) target[key] = values.toArray(true);
        }
        const sources = source.getValue("sources") as Result[] | undefined;
        if (sources) target.sources = sources.map((value) => value.toObject(true));
    }
    return { eventName: decoded.name, args };
}
