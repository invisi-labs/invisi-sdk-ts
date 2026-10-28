import type { Provider, Signer } from "ethers";
import { ProtocolRpcClient, Invisi, Wallet, Protocol, EncryptedWalletCodec } from "@invisi-labs/sdk";
import { WasmProver } from "@invisi-labs/prover/wasm";
import { IndexedDBWalletStore } from "@invisi-labs/sdk/indexeddb";

/** Frontend entry: no Node modules, native prover or server-owned database. */
export async function connectBrowser(input: {
    evmPrivateKey: string;
    provider: Provider;
    signer?: Signer;
    storageKey: CryptoKey;
    databaseName: string;
    protocolRpcUrl: string;
}) {
    const protocolRpc = new ProtocolRpcClient(input.protocolRpcUrl);

    // 1. A wallet integration supplies the account key locally, not through a public RPC API.
    // The application owns mnemonic derivation, backup and unlock.
    const wallet = await Wallet.fromPrivateKey(input.evmPrivateKey);

    // 2. Supply an application-owned AES key and choose a persistent browser database explicitly.
    const store = new IndexedDBWalletStore(input.databaseName, EncryptedWalletCodec.fromKey(input.storageKey));

    try {
        // 3. Select WASM explicitly. No remote or native fallback receives the private witness.
        const protocol = await Protocol.fromRpc(protocolRpc, input.provider);
        const invisi = new Invisi({
            provider: input.provider,
            ...(input.signer ? { signer: input.signer } : {}),
            store,
            protocolRpc,
            prover: new WasmProver({ threads: 1 }),
        });
        const session = await invisi.connect({
            wallet,
            protocol,
        });

        await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });

        // 4. Return an explicit lifetime: the application owns its service subscription.
        return {
            session,
            close: async () => {
                await store.close();
            },
        };
    } catch (error) {
        await store.close();
        throw error;
    }
}
