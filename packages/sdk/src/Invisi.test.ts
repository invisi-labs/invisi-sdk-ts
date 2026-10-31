import { defineDeployment } from "@invisi-labs/rpc";
import { expect, expectTypeOf, it, vi } from "vitest";
import { Invisi, Wallet, Protocol, type ChainReader } from "./index";
import { MemoryWalletStore, reserveInputs, type WalletScope } from "./session";

const factory = "0x1111111111111111111111111111111111111111" as const;
const otherFactory = "0x6666666666666666666666666666666666666666" as const;
const token = "0x3333333333333333333333333333333333333333" as const;
const instance = "0x4444444444444444444444444444444444444444" as const;
const second = "0x5555555555555555555555555555555555555555" as const;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
function setup() {
    const chainReader = {
        getChainId: async () => 31337n,
        getCode: async (address: string) => "0x6000",
        getFactoryInstanceAddress: vi.fn(async (address: string) =>
            address === factory ? instance : second
        ),
        isFactoryInstance: async () => true,
        getInstanceFactory: async (address: string) =>
            address === instance ? factory : otherFactory,
    } as unknown as ChainReader;
    const protocol = new Protocol({
        deployment: defineDeployment({
            chainId: "31337",
            protocol: {
                address: instance,
                runtimeCodeHash:
                    "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d",
                fromBlock: "5",
            },
        }),
    });
    return { chainReader, protocol };
}

it("requires explicit chain infrastructure and validates before creating a session", async () => {
    const { protocol, chainReader } = setup();
    const local = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const wallet = Wallet.fromAddress(local.getAddress());
    await expect(new Invisi().connect({ wallet, protocol })).rejects.toThrow(/reader/i);
    const session = await new Invisi({ chainReader }).connect({
        wallet,
        protocol,
    });
    expect(session.scope.protocolAddress).toBe(instance);
    expect(session.protocol.context.protocolAddress).toBe(instance);
    await expect(session.balance(token)).rejects.toThrow(/store/i);
    expect("applyUpdates" in session).toBe(false);
    expect(JSON.stringify(session)).not.toMatch(/privateKey|nullifierKey|seed/);
});

it("keeps same-token instances' inventories, reservations and operations isolated", async () => {
    const { protocol, chainReader } = setup();
    const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const store = new MemoryWalletStore();
    const invisi = new Invisi({ chainReader, store });
    const first = await invisi.connect({ wallet, protocol });
    const otherProtocol = new Protocol({
        deployment: defineDeployment({
            ...protocol.deployment,
            protocol: { ...protocol.deployment.protocol, address: second },
        }),
    });
    const other = await invisi.connect({ wallet, protocol: otherProtocol });
    await store.transaction(first.scope, (draft) => {
        draft.notes[word(1)] = {
            note: {
                chainId: 31337n,
                protocolAddress: BigInt(instance),
                walletIdentity: wallet.walletIdentity,
                tokenAddress: BigInt(token),
                amount: 100n,
                nonce: 1n,
            },
            commitment: word(1),
            treeId: 1n,
            leafIndex: 0,
            blockNumber: 12n,
            blockHash: word(12),
            spent: "unspent",
        };
        draft.observedThrough = { number: 12n, hash: word(12) };
    });
    await reserveInputs(store, first.scope, "first-operation", [word(1)]);
    expect((await store.readSnapshot(first.scope)).operations).toHaveProperty("first-operation");
    const empty = await store.readSnapshot(other.scope);
    expect(empty.notes).toEqual({});
    expect(empty.reservations).toEqual({});
    expect(empty.operations).toEqual({});
    expect(Object.isFrozen(first.scope)).toBe(true);
    expect(Object.isFrozen(first.protocol)).toBe(true);
});

it("preserves viewing-only permissions without constructing a scanner", async () => {
    const { protocol, chainReader } = setup();
    const local = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const invisi = new Invisi({ chainReader, store: new MemoryWalletStore() });
    const viewing = await invisi.connect({
        wallet: Wallet.fromAddress(local.getAddress()),
        protocol,
        viewing: local.getViewer(),
    });
    expect((await viewing.balance(token)).availableKnown).toBeNull();
    for (const method of ["sync", "resync", "startSync", "stopSync"])
        expect(method in viewing).toBe(false);
});

it("rejects a different runtime before touching wallet state", async () => {
    const { protocol, chainReader } = setup();
    chainReader.getCode = async () => "0x6001";
    const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const store = new MemoryWalletStore();
    const read = vi.spyOn(store, "readSnapshot");
    await expect(new Invisi({ chainReader, store }).connect({ wallet, protocol })).rejects.toThrow(
        /runtime/i
    );
    expect(read).not.toHaveBeenCalled();
});

it("composes read-only provider infrastructure lazily without starting synchronization", async () => {
    const { protocol } = setup();
    const provider = {
        getNetwork: vi.fn(async () => ({ chainId: 31337n })),
        getCode: vi.fn(async () => "0x6000"),
        call: vi.fn(async () => word(1)),
        getLogs: vi.fn(),
        on: vi.fn(),
    };
    const invisi = new Invisi({ provider: provider as never, store: new MemoryWalletStore() });
    expect(provider.getNetwork).not.toHaveBeenCalled();
    const local = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const session = await invisi.connect({
        wallet: Wallet.fromAddress(local.getAddress()),
        protocol,
    });
    expect(session.scope.protocolAddress).toBe(instance);
    expect((await session.balance(token)).availableKnown).toBeNull();
    expect(provider.getCode).toHaveBeenCalledWith(instance);
    expect(provider.getLogs).not.toHaveBeenCalled();
    expect(provider.on).not.toHaveBeenCalled();
    expect(Object.isFrozen(provider)).toBe(false);
});

it.each(["signer", "fundingSigner"])(
    "rejects the removed %s constructor option before using it",
    (key) => {
        const signer = { getAddress: vi.fn(), signTypedData: vi.fn() };
        expect(() => new Invisi({ [key]: signer } as never)).toThrow(/signer|signing/i);
        expect(signer.getAddress).not.toHaveBeenCalled();
        expect(signer.signTypedData).not.toHaveBeenCalled();
    }
);

it("does not expose signer defaults in the infrastructure constructor type", () => {
    expectTypeOf<
        Extract<keyof import("./Invisi").InvisiOptions, "signer" | "fundingSigner">
    >().toEqualTypeOf<never>();
});

it("validates the provider chain even when a custom reader is supplied", async () => {
    const { protocol, chainReader } = setup();
    const provider = { getNetwork: async () => ({ chainId: 1n }) };
    const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    await expect(
        new Invisi({ provider: provider as never, chainReader }).connect({ wallet, protocol })
    ).rejects.toThrow(/provider.*chain mismatch/i);
});

it("separates connection permissions from shared runtime infrastructure", () => {
    expectTypeOf<keyof import("./Invisi").ConnectionOptions>().toEqualTypeOf<
        "wallet" | "protocol" | "namespace" | "viewing" | "authorization"
    >();
});

it("rejects infrastructure overrides on connect before making a network request", async () => {
    const { protocol, chainReader } = setup();
    const wallet = await Wallet.fromPrivateKey(new Uint8Array(32).fill(1));
    const read = vi.spyOn(chainReader, "getChainId");
    await expect(
        new Invisi({ chainReader }).connect({
            wallet,
            protocol,
            store: new MemoryWalletStore(),
        } as never)
    ).rejects.toThrow(/connection option.*store/i);
    expect(read).not.toHaveBeenCalled();
});
