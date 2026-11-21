import profile from "./gas-profile.json";
import type { RouterPayment } from "./canonical";
export const ROUTER_GAS_PROFILE = Object.freeze({
    ...profile,
    modeOverhead: Object.freeze([...profile.modeOverhead]),
});
export interface RouterGasInput {
    coreGasUnits: number;
    mode: number;
    channel: number;
    hopCount: number;
    routeBytes: number;
    permit: boolean;
    authorizationCount: number;
    zeroExGasUnits?: number;
}
export type RouterGasEstimate =
    | { available: false; source: "model"; modelId: string; reason: string }
    | {
          available: true;
          source: "model";
          modelId: string;
          gasUnits: number;
          breakdown: {
              core: number;
              router: number;
              swap: number;
              permit: number;
              authorization: number;
              routeCalldata: number;
          };
      };
/** Conservative allowances, not measured swap benchmarks or a transaction gas limit. */
export function estimateRouterGas(input: RouterGasInput): RouterGasEstimate {
    const base = { source: "model" as const, modelId: profile.modelId };
    const unavailable = (reason: string): RouterGasEstimate => ({
        ...base,
        available: false,
        reason,
    });
    const safe = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (
        ![
            input.coreGasUnits,
            input.mode,
            input.channel,
            input.hopCount,
            input.routeBytes,
            input.authorizationCount,
        ].every(safe) ||
        input.coreGasUnits <= 0 ||
        input.mode > 3 ||
        input.channel > 2 ||
        typeof input.permit !== "boolean" ||
        input.routeBytes > profile.maxRouteBytes ||
        input.authorizationCount > 1 ||
        (input.authorizationCount > 0 && input.mode !== 3) ||
        (input.channel === 1
            ? input.hopCount < 1 || input.hopCount > profile.maxHops
            : input.hopCount !== 0) ||
        (input.channel === 0 && input.routeBytes !== 0)
    )
        return unavailable("invalid-router-gas-input");
    if (input.zeroExGasUnits !== undefined && !safe(input.zeroExGasUnits))
        return unavailable("invalid-router-gas-input");
    if (input.channel === 2 && (!input.zeroExGasUnits || input.zeroExGasUnits <= 0))
        return unavailable("zeroex-route-gas-unavailable");
    const breakdown = {
        core: input.coreGasUnits,
        router: profile.modeOverhead[input.mode]!,
        swap:
            input.channel === 1
                ? profile.v3Base + profile.v3PerHop * input.hopCount
                : input.channel === 2
                  ? input.zeroExGasUnits!
                  : 0,
        permit: input.permit ? profile.permit : 0,
        authorization: profile.authorization * input.authorizationCount,
        routeCalldata: profile.routeByte * input.routeBytes,
    };
    const gasUnits = Object.values(breakdown).reduce((a, b) => a + b, 0);
    if (!safe(gasUnits)) return unavailable("router-gas-overflow");
    return { ...base, available: true, gasUnits, breakdown };
}
/** Pass the existing PreparedTransaction.estimateGas().gasUnits as the Core baseline. */
export function estimateRouterPaymentGas(
    payment: RouterPayment,
    coreGasUnits: bigint | number,
    options: { authorizationCount?: number; zeroExGasUnits?: number } = {}
): RouterGasEstimate {
    const { route, intent } = payment;
    const routeBytes = (route.path.length + route.data.length - 4) / 2;
    return estimateRouterGas({
        coreGasUnits: Number(coreGasUnits),
        mode: intent.mode,
        channel: route.channel,
        hopCount: route.channel === 1 ? ((route.path.length - 2) / 2 - 20) / 23 : 0,
        routeBytes,
        permit: (payment.permit?.deadline ?? 0n) > 0n,
        authorizationCount: options.authorizationCount ?? 0,
        ...(options.zeroExGasUnits !== undefined ? { zeroExGasUnits: options.zeroExGasUnits } : {}),
    });
}
