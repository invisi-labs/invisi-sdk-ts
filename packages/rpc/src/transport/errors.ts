export class ProtocolRpcError extends Error {
    constructor(
        message: string,
        readonly kind: "validation" | "transport" | "http" | "rpc" | "aborted" | "timeout",
        readonly code?: number
    ) {
        super(message);
        this.name = "ProtocolRpcError";
    }
}

export const invalid = (message: string): never => {
    throw new ProtocolRpcError(message, "validation");
};
