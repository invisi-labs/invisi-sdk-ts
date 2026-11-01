import { PublicWallet } from "@invisi-labs/sdk";
import { HDNodeWallet, Mnemonic, Wallet as EthereumWallet, hexlify } from "ethers";
import { Wallet } from "@invisi-labs/sdk";

// This fully offline example uses a public test mnemonic, unrelated to the project's experimental Alice, Bob, or other accounts.
// This mnemonic is publicly known; do not send assets to accounts derived from it.

// 1. The application restores the mnemonic with ethers; the Invisi SDK does not handle mnemonics or HD derivation.
console.log("1. Restore the public test mnemonic with ethers");
const phrase = "test test test test test test test test test test test junk";
const mnemonic = Mnemonic.fromPhrase(phrase);

// 2. The application chooses a derivation path and obtains the 32-byte private key for this EVM account.
console.log("2. Derive the EVM account at m/44'/60'/0'/0/0");
const path = "m/44'/60'/0'/0/0";
const account = HDNodeWallet.fromMnemonic(mnemonic, path);
const privateKey = account.privateKey;
// Use the mnemonic and private key locally only; do not print them or write them to project account files.

// 3. Restore the ethers wallet from the private key, matching the EVM account derived from the mnemonic.
console.log("3. Restore the ethers wallet with the same private key");
const ethereumWallet = new EthereumWallet(privateKey);
const evmAddress = ethereumWallet.address;
console.log("EVM address:", evmAddress);

// 4. Wallet is a full wallet with private capabilities; it can only be restored from a private key.
// The SDK uses versioned key derivation to derive separate viewing and detection keys.
// Arbitrary spending authorization remains controlled by the original EVM private key; the same key restores the same Invisi wallet.
console.log("4. Restore the Invisi wallet with the same EVM private key");
const wallet = await Wallet.fromPrivateKey(privateKey);

// 5. Read the full 0i receiving address and its corresponding EVM owner address.
console.log("5. Read the Invisi receiving address and EVM owner address");
const receivingAddress = wallet.getAddress();
const ownerAddress = wallet.ownerAddress;
console.log("Invisi receiving address:", receivingAddress);
console.log("Receiving address length:", receivingAddress.length);
console.log("EVM owner address:", ownerAddress);
console.log("Owner address length:", ownerAddress.length);

if (ownerAddress !== evmAddress) {
    throw new Error("The Invisi owner address must match the ethers wallet address");
}

// 6. PublicWallet is a public wallet, separate from the full Wallet type.
// The full 0i address already contains receiving public keys and can receive funds directly.
// PublicWallet has no getViewer, getDetector, or exportAuthorization methods.
console.log("6. Import a public wallet from a full 0i address");
const publicReceivingWallet = PublicWallet.fromAddress(receivingAddress);
console.log("Full receiving address of the public wallet:", publicReceivingWallet.getAddress());

// 7. Obtain capability objects with the permissions other components need, without handing over the whole wallet.
console.log("7. Obtain viewing and detection capabilities");
const viewer = wallet.getViewer();
const detector = wallet.getDetector();

// 8. The viewing public key encrypts receipt data; the viewing private key allows note recovery and full sweeps to the original owner.
// Viewing capability cannot authorize arbitrary spending, but grants more than read-only access; make this clear when delegating it.
console.log("8. Read the viewing public key and explicitly export a copy of the viewing private key");
const viewingPublicKey = viewer.getPublicKey();
const viewingPrivateKey = viewer.exportKey();
console.log("Viewing public key:", hexlify(viewingPublicKey));
console.log("Viewing public key byte length:", viewingPublicKey.length);
console.log("Viewing private key byte length:", viewingPrivateKey.length);
// Do not print the private key; zero the exported copy after use. The viewer retains its own key internally.
viewingPrivateKey.fill(0);

// 9. The public clue key generates detection clues; the detection key only filters candidate outputs and cannot decrypt or spend them.
// Scanning services can check 1 to 24 prefix bits, balancing filtering precision against work.
console.log("9. Read the public clue key and explicitly export a copy of the detection key");
const clueKey = detector.getClueKey();
const detectionKey = detector.exportKey();
console.log("Public clue key:", hexlify(clueKey));
console.log("Public clue key byte length:", clueKey.length);
console.log("Detection key byte length:", detectionKey.length);
// Do not print the detection key; zero the exported copy after use. The detector retains its own key internally.
detectionKey.fill(0);
