import { mergeConfig } from "vitest/config";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import base from "../../packages/session/vitest.config";
const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = "4cf536e5c3e6569a21f5f2e952555949a627249d";
const frozenBaseline = process.env.SUBMIT_HTTP_BASELINE_DIR;
const historicalFiles = [
    "packages/session/src/operations/submission-validation.ts",
    "packages/sdk/src/transactions/execution/operation-execution.ts",
];
const frozenFiles = [
    ...historicalFiles,
    "packages/sdk/src/integrations/ethers.ts",
    "packages/rpc/src/bindings/client/TokenProtocol.ts",
    "packages/rpc/src/bindings/client/Protocol.ts",
    "packages/protocol/src/interfaces.ts",
    "packages/sdk/src/session-support.ts",
];
const optionalFrozenFiles = [
    "packages/session/src/operations/Operation.ts",
    "packages/sdk/src/integrations/ethers-submission-provider.ts",
    "packages/sdk/src/transactions/preparation/preparation-reads.ts",
    "packages/session/src/wallet/WalletSession.ts",
    "packages/sdk/src/transactions/preparation/prepare-common.ts",
    "packages/sdk/src/transactions/preparation/transaction-preparation.ts",
    "packages/sdk/src/broadcaster/broadcaster-preparation.ts",
    "packages/rpc/src/broadcaster.ts",
    "packages/sdk/src/protocol/Protocol.ts",
];
for (const path of optionalFrozenFiles) {
    if (frozenBaseline && existsSync(resolve(frozenBaseline, path))) frozenFiles.push(path);
}
export default mergeConfig(base, {
    root,
    resolve: {
        alias:
            process.env.SUBMIT_HTTP_VARIANT === "baseline" && !frozenBaseline
                ? []
                : [
                      {
                          find: /^@invisi-labs\/rpc$/,
                          replacement: resolve(root, "packages/rpc/src/index.ts"),
                      },
                      {
                          find: "@invisi-labs/rpc/broadcaster",
                          replacement: resolve(root, "packages/rpc/src/broadcaster.ts"),
                      },
                      {
                          find: "@invisi-labs/rpc/provenance",
                          replacement: resolve(root, "packages/rpc/src/provenance/index.ts"),
                      },
                      {
                          find: "@invisi-labs/rpc/trusted-provider",
                          replacement: resolve(root, "packages/rpc/src/trusted-provider.ts"),
                      },
                  ],
    },
    plugins:
        frozenBaseline || process.env.SUBMIT_HTTP_VARIANT === "baseline"
            ? [
                  {
                      name: "frozen-submit-baseline",
                      enforce: "pre" as const,
                      transform(_source: string, id: string) {
                          const path = (frozenBaseline ? frozenFiles : historicalFiles).find(
                              (path) => id.split("?")[0] === root + path
                          );
                          if (path)
                              return {
                                  code: frozenBaseline
                                      ? readFileSync(resolve(frozenBaseline, path), "utf8")
                                      : execFileSync("git", ["show", `${baseline}:${path}`], {
                                            cwd: root,
                                            encoding: "utf8",
                                        }),
                                  map: null,
                              };
                      },
                  },
              ]
            : [],
    test: {
        include: ["packages/session/src/operations/submit-http.profile.test.ts"],
        testTimeout: 180000,
        hookTimeout: 180000,
    },
});
