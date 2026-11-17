import { invisiValidation } from "../methods/invisi/validation";
import { invalid } from "./errors";

const methods = new Map([["invisi", invisiValidation]]);
/** Route only implemented methods; unrecognized methods never reach wallet execution. */
export function methodValidation(value: unknown) {
    if (typeof value !== "string") return invalid();
    const validation = methods.get(value);
    if (!validation) return invalid();
    return validation;
}
