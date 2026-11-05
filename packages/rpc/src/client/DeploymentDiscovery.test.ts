import { describe, expect, it, vi } from "vitest";
import { ProtocolRpcError } from "./ProtocolRpcClient";
import { block, context, deployment, h, setup, status } from "./ProtocolRpcClient-fixtures";

describe("RPC deployment discovery", () => {
    const wire = () => ({
        apiVersion: "v1",
        protocolVersion: "1",
        deployment: {
            ...status().deployment,

            registry: {
                address: "0x2222222222222222222222222222222222222222",
                runtimeCodeHash: h(7),
                fromBlock: 0,
            },
        },
    });
    it("loads frozen deployment and registry pins before indexed queries", async () => {
        const { client, requests, reader } = setup(
            (method) => (method === "invisi_getDeployment" ? wire() : status()),
            { deployment: undefined }
        );
        await expect(client.getStatus(context)).rejects.toThrow(/Load the RPC deployment/);
        expect(requests).toHaveLength(0);
        const result = await client.getDeployment(31337n);
        expect(result.chainId).toBe(31337n);
        expect(result.registry?.fromBlock).toBe(0n);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.registry)).toBe(true);
        expect(reader.getBlock).not.toHaveBeenCalled();
        expect((await client.getStatus(context)).indexedHead).toEqual(block);
    });
    it.each([
        { apiVersion: "v2" },
        { protocolVersion: "2" },
        { deployment: { ...wire().deployment, chainId: "1" } },
        {
            deployment: {
                ...wire().deployment,
                protocol: { ...wire().deployment.protocol, runtimeCodeHash: h(0) },
            },
        },
        {
            deployment: {
                ...wire().deployment,
                protocol: { ...wire().deployment.protocol, fromBlock: Number.MAX_SAFE_INTEGER + 1 },
            },
        },
        {
            deployment: {
                ...wire().deployment,
                registry: { ...wire().deployment.registry, runtimeCodeHash: "0x" },
            },
        },
    ])("rejects malformed or foreign deployment without binding the client %j", async (patch) => {
        let bad = true;
        const { client } = setup(() => (bad ? { ...wire(), ...patch } : wire()), {
            deployment: undefined,
        });
        await expect(client.getDeployment(31337n)).rejects.toBeInstanceOf(ProtocolRpcError);
        bad = false;
        await expect(client.getDeployment(31337n)).resolves.toHaveProperty("chainId", 31337n);
    });
    it("rejects later configuration changes including registry pins", async () => {
        let changed = false;
        const { client } = setup(
            () => {
                const value = wire();
                if (changed) value.deployment.registry.runtimeCodeHash = h(8);
                return value;
            },
            { deployment: undefined }
        );
        const loaded = await client.getDeployment(31337n);
        changed = true;
        await expect(client.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
        expect(loaded.registry?.runtimeCodeHash).toBe(h(7));
    });
    it("pins broadcaster registry metadata across discovery and cloned readers", async () => {
        let changed = false;
        const { client, reader } = setup(
            () => ({
                ...wire(),
                deployment: {
                    ...wire().deployment,
                    broadcasterRegistry: {
                        ...wire().deployment.registry,
                        runtimeCodeHash: h(changed ? 9 : 8),
                    },
                },
            }),
            { deployment: undefined }
        );
        const loaded = await client.getDeployment(31337n);
        expect(loaded.broadcasterRegistry?.runtimeCodeHash).toBe(h(8));
        const clone = client.withReader(reader);
        changed = true;
        await expect(client.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
        await expect(clone.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
    });
    it("accepts a service matching independent application pins", async () => {
        const { client } = setup(() => ({
            ...wire(),
            deployment: { ...status().deployment },
        }));
        await expect(client.getDeployment(31337n)).resolves.toEqual(deployment);
    });
    it("honors explicit application pins and cancellation", async () => {
        const { client } = setup(() => wire());
        await expect(client.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
        const controller = new AbortController();
        controller.abort();
        await expect(
            client.getDeployment(31337n, { signal: controller.signal })
        ).rejects.toMatchObject({ kind: "aborted" });
    });
});

describe("versioned service URLs", () => {
    it.each([
        ["https://example.org/v1", "https://example.org/v1/chains/31337"],
        [
            "https://example.org/proxy/v1/?access=opaque",
            "https://example.org/proxy/v1/chains/31337?access=opaque",
        ],
    ])("selects a chain from %s without changing the configured service", async (url, expected) => {
        const { client, fetchMock } = setup(() => status(), { url, deployment: undefined });
        expect((await client.getDeployment(31337n)).chainId).toBe(31337n);
        expect((await client.getStatus(context)).indexedHead).toEqual(block);
        expect((await client.getDeployment(31337n)).protocol.address).toBe(
            deployment.protocol.address
        );
        for (const call of vi.mocked(fetchMock).mock.calls) expect(call[0]).toBe(expected);
    });

    it("routes an independently pinned deployment without a discovery request", async () => {
        const { client, fetchMock, requests } = setup(() => status(), {
            url: "https://example.org/v1",
        });
        await client.getStatus(context);
        expect(requests.map((request) => request.method)).toEqual(["invisi_getStatus"]);
        expect(vi.mocked(fetchMock).mock.calls[0]?.[0]).toBe("https://example.org/v1/chains/31337");
    });
});
