import { runtime, proveAndSend, viewer, EthereumWallet } from "./runtime.js";
import { discoverCredits } from "./discover-credits.js";
const h = await runtime();
try {
    const bob = h.accounts[1]!,
        states = await discoverCredits({ ...h, wallet: bob.publicWallet, viewer: viewer(bob), role: "owner" }),
        selected = states[0];
    if (!selected) throw Error("No current owner Credit state discovered");
    const update = await h.invisi.prepareUpdateCredit({
        wallet: bob.publicWallet,
        protocol: h.protocol,
        tokenAddress: h.tokenAddress,
        creditInputs: [selected],
        credit: selected.commitment,
        singleLimit: 10n,
        dailyLimit: 40n,
        monthlyLimit: 60n,
        lifetimeLimit: 100n,
    });
    await proveAndSend(update, new EthereumWallet(bob.privateKey, h.provider));
} finally {
    h.provider.destroy();
}
