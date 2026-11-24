import { AddressRegistry as Registry, type RegistrationPreparation } from "@invisi-labs/rpc";
import type { Provider } from "ethers";
import { prepareWithErrors } from "../errors";

/** Registry operations accept the application's existing ethers provider. */
export class AddressRegistry extends Registry {
    override prepareRegistration(
        options:
            | RegistrationPreparation
            | (Omit<RegistrationPreparation, "reader"> & { provider: Provider })
    ) {
        return prepareWithErrors("prepareRegistration", async () => {
            if ("provider" in options) {
                const { EthersChainReader } = await import("../integrations/ethers");
                const { provider, ...preparation } = options;
                return super.prepareRegistration({
                    ...preparation,
                    reader: new EthersChainReader(provider),
                });
            }
            return super.prepareRegistration(options);
        });
    }
}
