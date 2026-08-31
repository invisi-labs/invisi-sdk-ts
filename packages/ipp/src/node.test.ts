import { describe, it, expect } from "vitest"
import { nodeHostResolver } from "./node"

// The point of this file is that `node:dns` is reachable from ./node and from
// nowhere else. link.ts holding no such specifier is what keeps web bundlers
// and Metro able to parse the main entry at all, so it is asserted directly.

describe("nodeHostResolver", () => {
  it("returns every address a name answers with", async () => {
    const addresses = await nodeHostResolver("localhost")
    expect(addresses.length).toBeGreaterThan(0)
    // Not `toContain("127.0.0.1")`: a v6-first machine answers ::1 alone. What
    // matters is that the list is addresses, and that all of them come back.
    for (const a of addresses) expect(a).toMatch(/^[0-9a-f.:]+$/i)
  })

  // No NXDOMAIN case here: resolvers that answer every name with a landing-page
  // address are common enough on consumer networks that such a test fails on
  // the machine, not on the code. The rejection path that matters -- a lookup
  // failure surfacing as ConnectionError -- is in link.dns.test.ts, where the
  // resolver is injected and the failure is the test's own.
})
