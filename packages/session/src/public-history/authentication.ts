import type { PublicHistoryPage } from "./store";
const pages = new WeakMap<object, PublicHistoryPage>();
/** In-process capability, issued only after authenticated public storage is read. */
export function certifyHistoryBatch(batch: object, page: PublicHistoryPage): void {
    pages.set(batch, page);
}
export function certifiedHistoryBatch(batch: object): PublicHistoryPage | undefined {
    return pages.get(batch);
}
