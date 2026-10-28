/** A requested permission was not explicitly supplied to this component. */
export class MissingCapabilityError extends Error {
    readonly code = "MISSING_CAPABILITY";
    constructor(readonly capability: string) {
        super(`Missing ${capability} capability`);
        this.name = "MissingCapabilityError";
    }
}
