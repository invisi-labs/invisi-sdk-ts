/**
 * Node-only entry: name resolution for `resolveIPPLink`'s rule 4.
 *
 * This lives in its own module, and its own subpath export, because naming a
 * Node builtin is not free for the other consumers. A specifier that appears
 * in the main entry is one every bundler must resolve: web bundlers fail on
 * `node:dns`, and Metro rejects the usual dodge -- a non-literal specifier --
 * at parse time, taking the whole app bundle down with it. Keeping the
 * specifier out of the main entry is the only form that costs nobody.
 *
 * The import below stays a literal on purpose: that is what keeps it
 * interceptable by a module mock, which is how the DNS rules are tested.
 */
import { promises as dns } from "node:dns"

import type { HostResolver } from "./link"

/**
 * Resolves via `node:dns`, returning every address the name answers with.
 *
 * Rule 4 judges every answer, not the first, so this must not collapse the
 * list: a name answering with one public and one internal address would
 * otherwise be a coin flip decided by whichever record connect happens to use.
 */
export const nodeHostResolver: HostResolver = async (hostname: string) => {
  const answers = await dns.lookup(hostname, { all: true, verbatim: true })
  return answers.map((a) => a.address)
}
