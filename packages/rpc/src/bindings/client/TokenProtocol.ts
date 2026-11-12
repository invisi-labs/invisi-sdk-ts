import { keccak256 } from "ethers";
import type { Hex } from "@invisi-labs/protocol/contracts";

import { MissingCapabilityError } from "@invisi-labs/primitives";
import {
    buildCreateCreditCalldata,
    type BuildCreateCreditCalldataParams,
} from "@invisi-labs/protocol";
import {
    buildRevokeCreditCalldata,
    buildCreditDrawCalldata,
    buildUpdateCreditCalldata,
    type BuildRevokeCreditCalldataParams,
    type BuildCreditDrawCalldataParams,
    type BuildUpdateCreditCalldataParams,
} from "@invisi-labs/protocol";
import {
    buildTransactAggregateCalldata,
    type BuildTransactAggregateCalldataParams,
} from "@invisi-labs/protocol";
import { buildTransactCalldata, type BuildTransactCalldataParams } from "@invisi-labs/protocol";
import { buildShieldCalldata, type BuildShieldCalldataParams } from "@invisi-labs/protocol";
import type { ChainReader } from "@invisi-labs/protocol";
import { normalizeContext, type TransactionContext } from "@invisi-labs/protocol";

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
        const [chainId, code, tokenCode] = await Promise.all([
            reader.getChainId(),
            reader.getCode(this.context.protocolAddress),
            reader.getCode(this.context.tokenAddress),
        ]);
        if (chainId !== this.context.chainId) {
            throw new Error("deployment chain mismatch");
        }
        if (
            !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
            (this.expectedRuntimeCodeHash &&
                (keccak256(code) as Hex) !== this.expectedRuntimeCodeHash)
        ) {
            throw new Error("deployment runtime code profile mismatch");
        }
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

    revokeCredit(request: Omit<BuildRevokeCreditCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildRevokeCreditCalldata({ ...request, context: this.context }),
        };
    }

    updateCredit(request: Omit<BuildUpdateCreditCalldataParams, "context">) {
        return {
            to: this.context.protocolAddress,
            value: 0n,
            ...buildUpdateCreditCalldata({ ...request, context: this.context }),
        };
    }
}
