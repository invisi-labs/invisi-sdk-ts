import { settings } from "../settings.js";
import { Contract, JsonRpcProvider, Wallet as EthereumWallet, parseUnits, formatUnits } from "ethers";
import { erc20Abi } from "viem";
import { Invisi, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { getAccounts } from "../accounts.js";

// Prepare funds once before a full suite. Every explicit run creates new notes.
if (!process.argv.includes("--execute")) {
    throw new Error("Review this file, then add --execute to run");
}
const [alice, bob, charlie, , , frank] = getAccounts();
const provider = new JsonRpcProvider(settings.chainRpcUrl);
try {
    if ((await provider.getNetwork()).chainId !== settings.chainId) {
        throw new Error("Connected chain does not match settings.chainId");
    }
    const protocolRpc = new ProtocolRpcClient(settings.protocolRpcUrl);
    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const signer = new EthereumWallet(alice.privateKey, provider);
    // ERC20 tokens cannot pay gas. Fund transaction submitters with the configured native currency.
    const gasBalances = [];
    for (const account of [alice, bob, charlie, frank]) {
        const balance = await provider.getBalance(account.address);
        gasBalances.push({
            account: account.name,
            nativeBalance: formatUnits(balance, settings.nativeCurrencyDecimals),
            symbol: settings.nativeCurrencySymbol,
            hasGas: balance > 0n,
        });
    }
    console.table(gasBalances);
    console.log(
        `Fund Alice and Bob first; the configured starting suggestion is ${settings.suggestedGasBalance} ${settings.nativeCurrencySymbol} each.`
    );
    console.log(
        `Alice tops up Charlie and Frank to ${settings.helperGasBalance} ${settings.nativeCurrencySymbol}. Other recipients need no gas.`
    );
    if (gasBalances.slice(0, 2).some((entry) => !entry.hasGas)) {
        throw new Error(`Alice or Bob has no ${settings.nativeCurrencySymbol}. Fund the account before running the suite.`);
    }
    // Charlie creates/cancels credit; Frank sweeps for Alice. Both need their own gas.
    for (const account of [charlie, frank]) {
        const balance = await provider.getBalance(account.address);
        const target = parseUnits(settings.helperGasBalance, settings.nativeCurrencyDecimals);
        if (balance < target) {
            const transaction = await signer.sendTransaction({
                to: account.address,
                value: target - balance,
            });
            console.log(account.name, "Gas funding:", transaction.hash);
            await transaction.wait();
        }
    }
    const tokenAddress = settings.tokenAddress;
    const token = new Contract(tokenAddress, erc20Abi, signer);
    const amount = parseUnits("1", Number(await token.decimals()));
    // Eight Alice notes cover withdrawals and sessions; four each for Bob and Charlie cover aggregation and credit.
    const outputs = [
        ...Array.from({ length: 8 }, () => ({ to: alice.receivingAddress, amount })),
        ...Array.from({ length: 4 }, () => ({ to: bob.receivingAddress, amount })),
        ...Array.from({ length: 4 }, () => ({ to: charlie.receivingAddress, amount })),
    ];
    const total = amount * BigInt(outputs.length);
    const allowance = await token.allowance(alice.address, protocol.context.protocolAddress);
    if (allowance < total) {
        if (allowance > 0n) {
            const reset = await token.approve(protocol.context.protocolAddress, 0n);
            console.log("Reset approval:", reset.hash);
            await reset.wait();
        }
        const approval = await token.approve(protocol.context.protocolAddress, total);
        console.log("Suite funding approval:", approval.hash);
        await approval.wait();
    }
    const invisi = new Invisi({ provider, protocolRpc });
    // Shield supports at most ten outputs per call; two batches create eight Alice, four Bob and four Charlie notes.
    for (let offset = 0; offset < outputs.length; offset += 10) {
        const batch = outputs.slice(offset, offset + 10);
        const prepared = await invisi.prepareShield({
            wallet: alice.publicWallet,
            protocol,
            tokenAddress,
            outputs: batch,
            funding: {
                payer: alice.address,
                amount: amount * BigInt(batch.length),
                authorization: "caller",
            },
        });
        const ready = await prepared.ready();
        const transaction = await signer.sendTransaction(await ready.exportTransaction());
        console.log("Suite seed transaction:", transaction.hash);
        const receipt = await transaction.wait();
        if (!receipt || receipt.status !== 1) {
            throw new Error("Seed transaction did not succeed");
        }
        console.log("Seed confirmation block:", receipt.blockNumber);
    }
} finally {
    provider.destroy();
}
