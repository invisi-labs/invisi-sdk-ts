---
"@invisi-labs/ipp": patch
---

Move `node:dns` out of the main entry, and make `resolveIPPLink`'s transport
rules a caller's choice instead of a second export.

`link.ts` used to reach `node:dns` through a runtime-assembled specifier so that
web bundlers would not try to resolve it. Metro rejects a non-literal `import()`
at parse time and honours no ignore comment, so any React Native app that
imported anything from this package — a type, `IPPClient`, anything — failed to
bundle at all. The Node path now lives behind its own subpath export:

```ts
import { resolveIPPLink } from "@invisi-labs/ipp"
import { nodeHostResolver } from "@invisi-labs/ipp/node" // Node only

await resolveIPPLink(url, { hostResolver: nodeHostResolver })
```

The main entry names no Node builtin, so every bundler can parse it. A caller
that passes no `hostResolver` gets the host judged by how it is spelled, which
is all a browser could ever do; passing one restores the strong check, where a
public name whose A record points inside the network is refused.

**Breaking:** `resolveIPPLinkUnsafe` is gone. It is now an option on the one
function, which is how the rest of the ecosystem spells this:

```ts
await resolveIPPLink(url)                                   // https only (default)
await resolveIPPLink(url, { allowInsecureTransport: true }) // also http + private targets
```
