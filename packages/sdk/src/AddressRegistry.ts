import type { Provider } from "ethers";
import { AddressRegistry as Registry, type RegistrationPreparation } from "@invisi-labs/protocol";
import { EthersChainReader } from "./integrations/ethers";

/** Registry operations accept the application's existing ethers provider. */
export class AddressRegistry extends Registry {
    override prepareRegistration(
        options:
            | RegistrationPreparation
            | (Omit<RegistrationPreparation, "reader"> & { provider: Provider })
    ) {
        if ("provider" in options) {
            const { provider, ...preparation } = options;
            return super.prepareRegistration({
                ...preparation,
                reader: new EthersChainReader(provider),
            });
        }
        return super.prepareRegistration(options);
    }
}
