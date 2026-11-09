import {
    Wallet,
    ReceivingAddress,
    prepareWalletRequest,
    acceptWalletResponse,
} from "@invisi-labs/core";
import { getBytes } from "ethers";

// Offline replay of public material only; no account execution takes place here.
const response = {
    "version": 1,
    "id": "wallet.public",
    "ownerAddress": "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
    "method": "wallet.public",
    "result": {
        "viewingPublicKey": "0x0396f42bb298c8a0e74539294780d709799f9838c0b69a134f38c6d968f2921397",
        "clueKey": "0x1292f7299a65930b0476394e55b6475425fb3ee7445176537042966a4653bf06",
        "spendingPublicKey":
            "0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
    },
} as const;
const address = ReceivingAddress.from({
    ownerAddress: response.ownerAddress,
    viewingPublicKey: getBytes(response.result.viewingPublicKey),
    clueKey: getBytes(response.result.clueKey),
});
const wallet = Wallet.fromAddress(address);
const prepared = prepareWalletRequest(wallet, response.id, "wallet.public", {});
const publicMaterial = await acceptWalletResponse(prepared, response);
console.log("Owner:", wallet.ownerAddress);
console.log("Receiving address:", wallet.getAddress());
console.log("Verified public material:", publicMaterial);
