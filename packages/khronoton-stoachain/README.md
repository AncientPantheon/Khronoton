# @ancientpantheon/khronoton-stoachain

StoaChain adapter for [`@ancientpantheon/khronoton-core`](../khronoton-core). Wraps
the `@stoachain/*` runtime once and exposes an async factory that returns the
core `ChainRuntime` seam, so a host injects one object instead of reaching for
`@stoachain/*` directly.

## Install

```sh
npm install @ancientpantheon/khronoton-stoachain
```

This package declares the StoaChain runtime as **peer dependencies** (they ship
WASM/crypto singletons and must resolve to a single copy in the consumer):

```sh
npm install \
  @stoachain/kadena-stoic-legacy@^4.3.6 \
  @stoachain/stoa-core@^4.3.6 \
  @stoachain/ouronet-core@^4.3.6
```

## Usage

```ts
import { createStoachainRuntime } from "@ancientpantheon/khronoton-stoachain";

const runtime = await createStoachainRuntime({ nodeBaseUrl: "https://node.example" });
```

> The factory signature is scaffolded; the `@stoachain/*` wiring lands in Phase B.
