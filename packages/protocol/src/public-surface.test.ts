import { expect, it } from "vitest";
import * as protocol from "./index";

it("exposes unified transact builders without dedicated withdrawal aliases", () => {
    expect(typeof protocol.buildTransactCalldata).toBe("function");
    expect(protocol).not.toHaveProperty("buildWithdrawalCalldata");
    expect(protocol).not.toHaveProperty("buildUnsignedWithdrawalCalldata");
});
