import { JsonRpcProvider, Wallet as EthereumWallet, Contract, Signature, TypedDataEncoder } from "ethers";
import { ProtocolRpcClient, Wallet, Protocol, Invisi, type Address, type Hex } from "@invisi-labs/sdk";
import { required } from "../environment.js";
import type { ExampleResources } from "../resources.js";

/** EIP2612 is an explicit token permission. It does not replace the private wallet authority. */
export async function main(resources: ExampleResources) {
    const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
    resources.defer(() => provider.destroy());
    const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));

    const protocol = await Protocol.fromRpc(protocolRpc, provider);
    const wallet = await Wallet.fromPrivateKey(required("WALLET_ACCOUNT_PRIVATE_KEY"));
    // Seeded local token; change this address when using another deployment.
    const tokenAddress = "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318" as const;

    const signer = new EthereumWallet(process.env.FUNDING_PRIVATE_KEY ?? required("WALLET_ACCOUNT_PRIVATE_KEY"), provider);
    const payer = (await signer.getAddress()) as Address;

    const invisi = new Invisi({
        protocolRpc,
        provider,
    });
    console.log("1. Read the token's independent permit nonce and authenticate its configured EIP712 domain");

    const token = tokenAddress;
    const tokenContract = new Contract(
        token,
        [
            "function name() view returns (string)",
            "function nonces(address owner) view returns (uint256)",
            "function DOMAIN_SEPARATOR() view returns (bytes32)",
        ],
        provider
    );
    const block = await provider.getBlock(await provider.getBlockNumber());
    if (!block) throw new Error("Missing canonical block");
    const amount = 100n;
    const deadline = BigInt(block.timestamp) + 300n;
    const name = await tokenContract.getFunction("name")({ blockTag: block.number });
    const nonce = await tokenContract.getFunction("nonces")(payer, { blockTag: block.number });

    const domain = {
        name,
        version: "1",
        chainId: protocol.deployment.chainId,
        verifyingContract: token,
    };
    const types = {
        Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
        ],
    };
    const message = { owner: payer, spender: protocol.context.protocolAddress, value: amount, nonce, deadline };
    const separator = await tokenContract.getFunction("DOMAIN_SEPARATOR")({ blockTag: block.number });
    if (TypedDataEncoder.hashDomain(domain) !== separator) throw new Error("Token permit domain mismatch");

    console.log("2. Request a token permit signature locally; prepare the shield with the exact permit fields");
    const signature = Signature.from(await signer.signTypedData(domain, types, message));

    const permit = {
        deadline,
        r: signature.r as Hex,
        s: signature.s as Hex,
        v: signature.v,
    };

    const prepared = await invisi.prepareShield({
        wallet,
        protocol,
        tokenAddress,
        outputs: [{ to: wallet.getAddress(), amount }],
        funding: { payer, amount, authorization: "caller", permit },
    });
    console.log("Local operation review:", prepared.preview());

    console.log("3. Review and encode the caller-funded shield; no Noir proof is required");
    const ready = await prepared.ready();

    const call = await ready.exportTransaction();
    const transaction = await signer.sendTransaction(call);
    console.log("Submitted transaction:", transaction.hash);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) throw new Error("Shield was not confirmed successfully");
    console.log("Confirmed block:", receipt.blockNumber);
    // Your application obtains and authenticates the resulting notes from Protocol RPC updates.
}
