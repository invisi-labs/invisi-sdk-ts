import type { PreparedOutput } from "../transactions/operation-types";
import { exportPaymentNote } from "../payment-note/export";

/** Detached final output snapshot, including any generated change. Contains private Note data. */
export class TransactionOutput {
    readonly #output: PreparedOutput;
    constructor(output: PreparedOutput) {
        this.#output = structuredClone(output);
        Object.freeze(this);
    }
    get context() {
        return structuredClone(this.#output.context);
    }
    get recipient() {
        return structuredClone(this.#output.recipient);
    }
    get amount() {
        return this.#output.amount;
    }
    get commitment() {
        return this.#output.commitment;
    }
    get identity() {
        return this.#output.identity;
    }
    get nonce() {
        return this.#output.note?.nonce;
    }
    get change() {
        return this.#output.change;
    }
    exportPaymentNote(): string {
        return exportPaymentNote(this.#output);
    }
}
