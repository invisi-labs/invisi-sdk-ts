import { Wallet, prepareWalletRequest, acceptWalletResponse } from "@invisi-labs/core";
import { LocalWallet } from "@invisi-labs/core/local";

// Public test key only. Production mobile applications pass requests to their native Vault.
const local = await LocalWallet.fromPrivateKey("0x" + "00".repeat(31) + "01");
const wallet = Wallet.fromAddress(local.getAddress());
const prepared = prepareWalletRequest(wallet, "public-example", "wallet.public", {});
const response = await local.execute(prepared.request);
const material = await acceptWalletResponse(prepared, response);
console.log("Owner:", wallet.ownerAddress);
console.log("Receiving address:", wallet.getAddress());
console.log("Public material:", material);
// The same request and response can cross an RN bridge without exposing private keys.
