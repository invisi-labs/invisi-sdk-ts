import { runtime, proveAndSend, viewer, EthereumWallet } from "./runtime.js";
import { discoverCredits } from "./discover-credits.js";
const h = await runtime();
try {
    const alice = h.accounts[0]!,
        states = await discoverCredits({ ...h, wallet: alice.publicWallet, viewer: viewer(alice), role: "spender" });
    if (!states.length) throw Error("No unrevoked current Credit states discovered");
    const draw = await h.invisi.prepareDrawCredit({
        wallet: alice.publicWallet,
        protocol: h.protocol,
        tokenAddress: h.tokenAddress,
        creditInputs: states.slice(0, 2),
        credits: states.slice(0, 2).map((state) => ({ credit: state.commitment, amount: 7n })),
        recipient: alice.receivingAddress,
    });
    await proveAndSend(draw, new EthereumWallet(alice.privateKey, h.provider));
} finally {
    h.provider.destroy();
}
