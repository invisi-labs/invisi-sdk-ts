// SDK 1.3.3 API. This standalone script can submit transactions with --execute.
import {
    Contract,
    JsonRpcProvider,
    Wallet as EthereumWallet,
    ZeroAddress,
    parseUnits,
} from "ethers";

import { Invisi, NoteOutput, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { NativeProver, checkBBAvailable } from "@invisi-labs/prover/native";
import { getAccounts } from "../accounts.js";
import { settings } from "../settings.js";
import {
    PaymentMode,
    PaymentRouterClient,
    UniswapV3Adapter,
    finalizeRouterPayment,
    PaymentRouterRelayClient,
    buildRouterPaymentDraft,
    estimateRouterPaymentGas,
    prepareNativeAccountPayment,
    unsignedDelegation,
    buildAccountPaymentDraft,
    buildAccountPayment,
    signNativePayment,
    validateDelegation,
} from "@invisi-labs/payment-router";
import type { Authorization } from "ethers";

const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
];

if (!process.argv.includes("--execute")) {
    console.log("Review this scenario and configure placeholders, then pass --execute");
    process.exit(0);
}

// Pin these addresses from reviewed deployment records, never from a quote response.
const routerAddress = "0x0000000000000000000000000000000000000000";
const coreAddress = "0x0000000000000000000000000000000000000000";
const wethAddress = "0x0000000000000000000000000000000000000000";
const uniswapRouterAddress = "0x0000000000000000000000000000000000000000";
const tokenAddress = "0x0000000000000000000000000000000000000000";
const quoterV2Address = "0x0000000000000000000000000000000000000000";
const implementation = "0x0000000000000000000000000000000000000000";
const implementationCodeHash = "0x0000000000000000000000000000000000000000000000000000000000000000";
// Retain the action nonce after revocation. Use 0n only for a verified fresh account.
const persistedUndelegatedNonce: bigint | undefined = undefined;
const broadcasterEndpoint = "https://PLACEHOLDER.invalid/router";
const quoteSigner = "0x0000000000000000000000000000000000000000";
const feeRecipient = "0x0000000000000000000000000000000000000000";
const relayer = "0x0000000000000000000000000000000000000000";
if (
    [
        routerAddress,
        coreAddress,
        wethAddress,
        uniswapRouterAddress,
        tokenAddress,
        quoterV2Address,
        quoteSigner,
        feeRecipient,
        relayer,
        implementation,
    ].some((address) => address === ZeroAddress)
) {
    throw new Error(
        "Configure independently verified deployment and trust addresses before execution"
    );
}
if (tokenAddress.toLowerCase() === wethAddress.toLowerCase()) {
    throw new Error("Native V3 input must buy a Core token different from WETH");
}
if (broadcasterEndpoint.includes("PLACEHOLDER")) {
    throw new Error("Configure the trusted Broadcaster HTTPS endpoint");
}
if (BigInt(implementationCodeHash) === 0n) {
    throw new Error("Configure the trusted account implementation runtime code hash");
}

const bbBin = settings.bbBin;
if (!(await checkBBAvailable(bbBin))) {
    throw new Error("Barretenberg 6.0.0 is required before connecting or sending");
}
const [alice, bob] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);

try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Configured chain mismatch");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    if (BigInt(protocol.context.protocolAddress) !== BigInt(coreAddress)) {
        throw new Error("Protocol RPC deployment does not match the pinned Core address");
    }
    const aliceSigner = new EthereumWallet(process.env.ALICE_PRIVATE_KEY!, provider);
    if (aliceSigner.address.toLowerCase() !== alice.address.toLowerCase()) {
        throw new Error("ALICE_PRIVATE_KEY must match the configured payer");
    }
    const token = new Contract(tokenAddress, erc20Abi, aliceSigner);
    const decimals = Number(await token.decimals());
    const invisi = new Invisi({
        provider,
        protocolRpc,
        prover: new NativeProver({ bbBin }),
    });
    const client = new PaymentRouterClient({
        provider,
        deployment: {
            chainId: settings.chainId,
            routerAddress,
            coreAddress,
            wethAddress,
            uniswapRouterAddress,
        },
    });
    const block = await provider.getBlock("latest");
    if (!block) {
        throw new Error("Missing latest block");
    }
    const deadline = BigInt(block.timestamp) + 3600n;
    // Public principal creates two hidden-amount Notes: real Core proof, no private inputs.
    const outputs = [
        await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: parseUnits("100", decimals),
            recipient: { type: "invisi", address: bob.receivingAddress },
        }),
        await NoteOutput.create({
            ...protocol.context,
            tokenAddress,
            amount: parseUnits("0.1", decimals),
            recipient: { type: "invisi", address: alice.receivingAddress },
        }),
    ];
    const relay = new PaymentRouterRelayClient({
        endpoint: broadcasterEndpoint,
        trust: {
            chainId: settings.chainId,
            core: coreAddress,
            quoteSigner,
            feeRecipient,
        },
    });
    const approvedCoreFeeAmount = parseUnits("0.1", decimals);
    const maxFeeAmount = parseUnits("0.2", decimals);
    const maxInput = parseUnits("0.02", settings.nativeCurrencyDecimals);
    const adapter = new UniswapV3Adapter({
        provider,
        quoterAddress: quoterV2Address,
        routes: [{ tokens: [wethAddress, tokenAddress], fees: [3000] }],
    });
    const provisional = await client.preparePayment({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        fee: { recipient: feeRecipient, amount: approvedCoreFeeAmount },
        deadline,
    });
    const provisionalQuote = await client.quote(adapter, {
        tokenIn: "0x0000000000000000000000000000000000000000",
        tokenOut: tokenAddress,
        amountOut: provisional.preview().funding.amount,
        maxInput,
        deadline,
        slippageBps: 50,
    });
    const provisionalDeadline =
        provisionalQuote.deadline < deadline ? provisionalQuote.deadline : deadline;
    const provisionalDraft = await client.prepareRouterPaymentDraft({
        payment: provisional,
        payer: alice.address,
        tokenIn: "0x0000000000000000000000000000000000000000",
        mode: PaymentMode.SponsoredNative,
        refundRecipient: alice.address,
        relayer,
        deadline: provisionalDeadline,
        amountInMaximum: provisionalQuote.maxInput,
        quote: provisionalQuote,
    });
    const provisionalAccount = await prepareNativeAccountPayment(
        provider,
        {
            chainId: settings.chainId,
            implementation,
            payer: alice.address,
            routerCall: buildRouterPaymentDraft(provisionalDraft),
            deadline: provisionalDeadline,
            relayer,
        },
        {
            implementationCodeHash,
            ...(persistedUndelegatedNonce !== undefined
                ? { undelegatedNonce: persistedUndelegatedNonce }
                : {}),
        }
    );
    const estimate = await relay.estimateRouterFee({
        coreCalldata: (await provisional.exportBroadcasterIntent()).data,
        outer: buildAccountPaymentDraft(provisionalAccount.payment),
        authorizationList: provisionalAccount.authorizationRequest
            ? [unsignedDelegation(provisionalAccount.authorizationRequest)]
            : [],
    });
    if (
        approvedCoreFeeAmount < BigInt(estimate.feeAmount) ||
        approvedCoreFeeAmount > maxFeeAmount
    ) {
        throw new Error("Service fee exceeds the approved budget; review and prepare again");
    }
    const prepared = await client.preparePayment({
        invisi,
        wallet: alice.publicWallet,
        protocol,
        tokenAddress,
        outputs,
        fee: { recipient: feeRecipient, amount: approvedCoreFeeAmount },
        deadline,
    });
    // Bob 100 + Alice 0.1 + service fee 0.1 = exactly 100.2 target tokens.
    const finalQuote = await client.quote(adapter, {
        tokenIn: "0x0000000000000000000000000000000000000000",
        tokenOut: tokenAddress,
        amountOut: prepared.preview().funding.amount,
        maxInput,
        deadline,
        slippageBps: 50,
    });
    const finalDeadline = finalQuote.deadline < deadline ? finalQuote.deadline : deadline;
    const draft = await client.prepareRouterPaymentDraft({
        payment: prepared,
        payer: alice.address,
        tokenIn: "0x0000000000000000000000000000000000000000",
        mode: PaymentMode.SponsoredNative,
        refundRecipient: alice.address,
        deadline: finalDeadline,
        relayer,
        amountInMaximum: finalQuote.maxInput,
        quote: finalQuote,
    });
    const account = await prepareNativeAccountPayment(
        provider,
        {
            chainId: settings.chainId,
            implementation,
            payer: alice.address,
            routerCall: buildRouterPaymentDraft(draft),
            deadline: finalDeadline,
            relayer,
        },
        {
            implementationCodeHash,
            ...(persistedUndelegatedNonce !== undefined
                ? { undelegatedNonce: persistedUndelegatedNonce }
                : {}),
        }
    );
    const baseline = prepared.estimateGas();
    if (!baseline.available) {
        throw new Error("Core gas preview unavailable");
    }
    const localGas = estimateRouterPaymentGas(draft, baseline.gasUnits, {
        authorizationCount: account.authorizationRequest ? 1 : 0,
    });
    if (!localGas.available) {
        throw new Error("Router gas model unavailable");
    }
    console.log("Local gas model:", localGas.gasUnits.toString());
    // Formal unsigned quote precedes proving and signing; business fields and nonces are pinned.
    const signedQuote = await relay.getQuote({
        coreCalldata: (await prepared.exportBroadcasterIntent()).data,
        outer: buildAccountPaymentDraft(account.payment),
        authorizationList: account.authorizationRequest
            ? [unsignedDelegation(account.authorizationRequest)]
            : [],
    });
    // Prove the real Core operation. Public funding does not require a Provenance input proof.
    const ready = await prepared.prove();
    const coreCall = await ready.exportTransaction();
    const payment = finalizeRouterPayment(draft, coreCall);
    const actualAccount = {
        ...account.payment,
        routerCall: client.buildRouterTransaction(payment),
    };
    const authorizationList: Authorization[] = [];
    if (account.authorizationRequest) {
        // Sign the exact EOA delegation nonce pinned before quotation. Delegation can survive failure.
        const authorization = await aliceSigner.authorize(account.authorizationRequest);
        validateDelegation(
            authorization,
            alice.address,
            implementation,
            settings.chainId,
            BigInt(account.authorizationRequest.nonce)
        );
        authorizationList.push(authorization);
    }
    const outer = buildAccountPayment(
        actualAccount,
        await signNativePayment(aliceSigner, actualAccount)
    );
    const simulation = await client.simulateRouterPayment(outer, {
        from: relayer,
        authorizationList,
    });
    console.log("Final transaction simulated gas:", simulation.gasEstimate.toString());
    // Explicit submission; persist the returned ID and poll status rather than recreate payment.
    const submission = await relay.submitTransaction(
        {
            coreCalldata: coreCall.data,
            outer,
            authorizationList,
        },
        signedQuote
    );
    console.log("Broadcaster request:", submission.id, submission.state);
    if (submission.transactionHash) {
        console.log("Transaction hash:", submission.transactionHash);
    }
} finally {
    provider.destroy();
}
