import { runtime, proveAndSend, EthereumWallet } from "./runtime.js";
// Grant private authority; no funds or ordinary Notes enter Credit creation.
const h = await runtime();
try {
    const [alice, bob, charlie] = h.accounts;
    for (const owner of [bob!, charlie!]) {
        const block = await h.provider.getBlock("latest");
        if (!block) throw Error("Missing latest block");
        const grant = await h.invisi.prepareCreateCredit({
            wallet: owner.publicWallet,
            protocol: h.protocol,
            tokenAddress: h.tokenAddress,
            spender: alice!.receivingAddress,
            expiry: BigInt(block.timestamp) + 86400n,
            singleLimit: 100n,
            dailyLimit: 1000n,
            monthlyLimit: 10000n,
            lifetimeLimit: 50000n,
        });
        await proveAndSend(grant, new EthereumWallet(owner.privateKey, h.provider));
    }
    console.log("Owners must separately provide balance and ERC20 allowance before draws.");
} finally {
    h.provider.destroy();
}
