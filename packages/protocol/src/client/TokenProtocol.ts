import { keccak256 } from "ethers";
import type { Hex } from "../contracts/index";

import { MissingCapabilityError } from "@invisi-labs/core";
import {
    buildCreateCreditCalldata,
    type BuildCreateCreditCalldataParams,
} from "../credit/credit-create";
import {
    buildCancelCreditCalldata,
    buildCreditDrawCalldata,
    buildTopUpCreditCalldata,
    type BuildCancelCreditCalldataParams,
    type BuildCreditDrawCalldataParams,
    type BuildTopUpCreditCalldataParams,
} from "../credit/credit-lifecycle";
import {
    buildTransactAggregateCalldata,
    type BuildTransactAggregateCalldataParams,
} from "../funds/aggregate";
import { buildTransactCalldata, type BuildTransactCalldataParams } from "../funds/calldata";
import { buildShieldCalldata, type BuildShieldCalldataParams } from "../funds/shield";
import type { ChainReader } from "../interfaces";
import { normalizeContext, type TransactionContext } from "../validation";

export interface TokenProtocolOptions {
    expectedRuntimeCodeHash?: Hex;
}

/** A token-specific operation binding within a multi-token deployment. Pure builders never sign or submit. */
export class TokenProtocol {
    readonly context: Readonly<TransactionContext>;
    readonly expectedRuntimeCodeHash: Hex | undefined;

    constructor(context: TransactionContext, options: TokenProtocolOptions = {}) {
        const normalized = normalizeContext(context);
        if (BigInt(normalized.protocolAddress) === 0n || BigInt(normalized.tokenAddress) === 0n) {
            throw new Error("deployment addresses must be nonzero");
        }
        if (
            options.expectedRuntimeCodeHash &&
            !/^0x[0-9a-fA-F]{64}$/.test(options.expectedRuntimeCodeHash)
        ) {
            throw new Error("invalid runtime code hash");
        }
        this.expectedRuntimeCodeHash = options.expectedRuntimeCodeHash?.toLowerCase() as
            Hex | undefined;
        this.context = Object.freeze(normalized);
        Object.freeze(this);
    }

    async validateDeployment(
        reader: Pick<ChainReader, "getChainId" | "getCode">,
        options: { requireRuntimeProfile?: boolean } = {}
    ): Promise<void> {
        if ((options.requireRuntimeProfile ?? true) && !this.expectedRuntimeCodeHash) {
            throw new MissingCapabilityError("trusted deployment profile");
        }
        if ((await reader.getChainId()) !== this.context.chainId) {
            throw new Error("deployment chain mismatch");
        }
        const code = await reader.getCode(this.context.protocolAddress);
        if (
            !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
            (this.expectedRuntimeCodeHash &&
                (keccak256(code) as Hex) !== this.expectedRuntimeCodeHash)
        ) {
            throw new Error("deployment runtime code profile mismatch");
        }
        const tokenCode = await reader.getCode(this.context.tokenAddress);
        if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(tokenCode)) {
            throw new Error("token address must have contract code");
        }
    }

    transact(request: Omit<BuildTransactCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildTransactCalldata({ ...request, context: this.context }),
        };
    }

    aggregate(request: Omit<BuildTransactAggregateCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildTransactAggregateCalldata({ ...request, context: this.context }),
        };
    }

    async shield(request: Omit<BuildShieldCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...(await buildShieldCalldata({ ...request, context: this.context })),
        };
    }

    createCredit(request: Omit<BuildCreateCreditCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildCreateCreditCalldata({ ...request, context: this.context }),
        };
    }

    drawCredit(request: Omit<BuildCreditDrawCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildCreditDrawCalldata({ ...request, context: this.context }),
        };
    }

    cancelCredit(request: Omit<BuildCancelCreditCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildCancelCreditCalldata({ ...request, context: this.context }),
        };
    }

    topUpCredit(request: Omit<BuildTopUpCreditCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildTopUpCreditCalldata({ ...request, context: this.context }),
        };
    }
}
