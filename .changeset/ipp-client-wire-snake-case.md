---
"@invisi-labs/ipp": patch
---

Fix IPPClient to convert wire fields between camelCase and snake_case at the HTTP boundary. It previously sent camelCase request bodies and read responses verbatim, so `/ipp/v1` requests were unparseable server-side and response fields came back `undefined`. Requests are now serialized as snake_case and responses decoded back to camelCase — the same conversion the QR/msgpack codec already applies; the error envelope is read as-is.
