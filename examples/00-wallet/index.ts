import { PublicWallet } from "@invisi-labs/sdk";
import { HDNodeWallet, Mnemonic, Wallet as EthereumWallet, hexlify } from "ethers";
import { Wallet } from "@invisi-labs/sdk";

/** Offline and deterministic. This mnemonic is public test data, never fund its accounts. */
export async function main() {
    // 1. The application restores a mnemonic. Invisi does not handle mnemonic derivation.
    console.log("1. Restore the public test mnemonic with ethers");
    const phrase = "test test test test test test test test test test test junk";
    const mnemonic = Mnemonic.fromPhrase(phrase);

    // 2. Select the Ethereum account and obtain its exportable 32-byte private key.
    console.log("2. Derive the EVM account private key at m/44'/60'/0'/0/0");
    const path = "m/44'/60'/0'/0/0";
    const account = HDNodeWallet.fromMnemonic(mnemonic, path);
    // Keep the mnemonic and private key local; do not log or return either secret.
    const privateKey = account.privateKey;

    // 3. A private-key import restores the same Ethereum address as the mnemonic.
    console.log("3. Restore the Ethereum wallet from that private key");
    const ethereumWallet = new EthereumWallet(privateKey);
    const evmAddress = ethereumWallet.address;

    console.log("Ethereum address:", evmAddress);

    // 4. The exact same EVM key is the input to Invisi's versioned KDF.
    // Invisi reuses this key for spending and derives separate viewing and detection keys.
    console.log("4. Derive the Invisi wallet from the same EVM private key");
    const wallet = await Wallet.fromPrivateKey(privateKey);

    console.log("5. Read the Invisi receiving address and EVM owner address");
    const receivingAddress = wallet.getAddress();
    const ownerAddress = wallet.ownerAddress;

    console.log("Invisi receiving address:", receivingAddress, receivingAddress.length, "characters");
    console.log("EVM owner address:", ownerAddress, ownerAddress.length, "characters");
    if (ownerAddress !== evmAddress) throw new Error("The owner address must equal the Ethereum wallet address");

    // Either address form can create an address-only wallet without a registry lookup.
    // Sending to the EVM owner address requires registered receiving keys; see 05-registry.
    console.log("6. Create address-only wallets from both address forms");
    const publicReceivingWallet = PublicWallet.fromAddress(receivingAddress);
    const ownerOnlyWallet = PublicWallet.fromAddress(ownerAddress);

    console.log("7. Get only the capabilities needed by another component");
    const viewer = wallet.getViewer();
    const detector = wallet.getDetector();

    console.log("8. Read the viewing public key and explicitly export the viewing private key");
    const viewingPublicKey = viewer.getPublicKey();
    // Sensitive: exporting this key grants viewing and owner-only full sweep, but no arbitrary spending.
    // Only pass it to a trusted viewing service over a secure channel; never log or return it.
    const viewingPrivateKey = viewer.exportKey();

    console.log("Viewing public key:", hexlify(viewingPublicKey));
    console.log("Viewing key sizes:", viewingPublicKey.length, "public bytes,", viewingPrivateKey.length, "private bytes");
    // Clear this exported copy after use. The viewer retains its own internal key.
    viewingPrivateKey.fill(0);

    console.log("9. Read the public clue key and explicitly export the detection key");
    const clueKey = detector.getClueKey();
    // Sensitive: delegate candidate filtering only, without decryption or spending permission.
    // The scanning service chooses how many prefix bits to check, from 1 to 24.
    const detectionKey = detector.exportKey();

    console.log("Public clue key:", hexlify(clueKey));
    console.log("Detection key sizes:", clueKey.length, "public bytes,", detectionKey.length, "secret bytes");
    // Never log or return the detection key. Clear this exported copy after use.
    detectionKey.fill(0);

    // Capability handles redact private material. Never print exportKey() results.
    return {
        evmAddress,
        receivingAddress,
        ownerAddress,
        publicReceivingWallet,
        ownerOnlyWallet,
        viewer,
        detector,
    };
}
