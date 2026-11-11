/** Explicit nonpersistent reference adapter, with no automatic production fallback. */
export { MemoryAtomicRecords, MemoryWalletStore } from "../index";

import { PublicHistoryStore, type PublicHistoryRetention } from "../public-history/store";
import { MemoryAtomicRecords } from "./store";
export class MemoryPublicHistoryStore extends PublicHistoryStore {
    constructor(options: { retention?: Partial<PublicHistoryRetention> } = {}) {
        super(new MemoryAtomicRecords(), { persistent: false, ...options });
    }
}
