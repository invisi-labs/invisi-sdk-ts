export {};

const commands = {
    wallet: () => import("./00-wallet/index.js"),
    connect: () => import("./01-connect/index.js"),
    "connect-custom": () => import("./01-connect/custom-deployment.js"),
    chains: () => import("./01-connect/chains.js"),
    shield: () => import("./02-shield/index.js"),
    "shield-permit": () => import("./02-shield/permit.js"),
    transfer: () => import("./03-funds/transfer.js"),
    sweep: () => import("./03-funds/sweep.js"),
    withdraw: () => import("./03-funds/withdraw.js"),
    "mixed-funding": () => import("./03-funds/mixed-funding.js"),
    "public-split": () => import("./03-funds/public-split.js"),
    "credit-create": () => import("./04-credit/create.js"),
    "credit-draw": () => import("./04-credit/draw.js"),
    "credit-top-up": () => import("./04-credit/top-up.js"),
    "credit-cancel": () => import("./04-credit/cancel.js"),
    registry: () => import("./05-registry/register.js"),
    "registry-update": () => import("./05-registry/update.js"),
    aggregate: () => import("./06-aggregation/index.js"),
    disclosure: () => import("./07-disclosure/index.js"),
    "disclosure-chain": () => import("./07-disclosure/verify-on-chain.js"),
    session: () => import("./08-wallet-session/index.js"),
    "session-transfer": () => import("./08-wallet-session/transfer.js"),
    refresh: () => import("./08-wallet-session/refresh.js"),
    recover: () => import("./08-wallet-session/recovery.js"),
} as const;
const command = process.argv[2] ?? "--list";

if (command === "--list") console.log(Object.keys(commands).join("\n"));
else if (!Object.hasOwn(commands, command)) throw new Error("Unknown example; run --list");
else {
    const cleanups: Array<() => void | Promise<void>> = [];
    const errors: unknown[] = [];
    try {
        const example = await commands[command as keyof typeof commands]();
        await example.main({ defer: (cleanup: () => void | Promise<void>) => cleanups.push(cleanup) });
    } catch (error) {
        errors.push(error);
    } finally {
        for (const cleanup of cleanups.reverse()) {
            try {
                await cleanup();
            } catch (error) {
                errors.push(error);
            }
        }
    }
    for (const error of errors) {
        console.error(error instanceof Error ? error.message : "Example did not complete");
    }
    if (errors.length) process.exitCode = 1;
}
