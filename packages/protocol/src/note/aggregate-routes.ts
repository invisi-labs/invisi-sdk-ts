export interface AggregateRoute {
    kind: "dedicated" | "mixed";
    capacity: number;
    count: number;
    name: string;
    publicInputCount: number;
}
export const AGGREGATE_ROUTES: readonly AggregateRoute[] = Object.freeze(
    [
        ...Array.from({ length: 10 }, (_, i) => i + 1).flatMap((capacity) =>
            [1, 2, 5].map((count) => ({
                kind: "dedicated" as const,
                capacity,
                count,
                name: `transact_aggregate_${capacity}_${count}`,
                publicInputCount: (17 + 3 * capacity) * count + 1,
            }))
        ),
        ...[2, 3, 4, 5].map((count) => ({
            kind: "mixed" as const,
            capacity: 0,
            count,
            name: `transact_aggregate_mixed_1_5_${count}`,
            publicInputCount: 33 * count + 5,
        })),
    ].map((route) => Object.freeze(route))
);
/** Select the canonical immutable route without reordering requests or changing member capacities. */
export function selectAggregateRoute(capacities: readonly number[]): AggregateRoute {
    if (
        !capacities.length ||
        Array.from(
            { length: capacities.length },
            (_, i) => Number.isInteger(capacities[i]) && capacities[i]! >= 1 && capacities[i]! <= 10
        ).some((v) => !v)
    )
        throw Error("unsupported aggregate capacities");
    const count = capacities.length,
        dedicated = AGGREGATE_ROUTES.find(
            (r) => r.kind === "dedicated" && r.capacity === capacities[0] && r.count === count
        );
    if (dedicated && capacities.every((c) => c === capacities[0])) return dedicated;
    const mixed = AGGREGATE_ROUTES.find((r) => r.kind === "mixed" && r.count === count);
    if (mixed && capacities.every((c) => c <= 5)) return mixed;
    throw Error("unsupported aggregate capacity/count combination");
}
