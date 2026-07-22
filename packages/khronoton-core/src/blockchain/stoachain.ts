import type { ChainRuntime } from "../server/index.js";

/**
 * `@ancientpantheon/khronoton-core/blockchain/stoachain` — the StoaChain edge.
 *
 * khronoton is chain-POLYGLOT, not chain-agnostic: the root `.` schedule engine
 * and the `/server` tick/store engine orchestrate, and each `/blockchain/<chain>`
 * subpath teaches them to speak one chain's language. This one wraps the
 * `@stoachain/*` runtime into the core {@link ChainRuntime} seam so a StoaChain
 * automaton injects one object instead of reaching for `@stoachain/*` directly.
 *
 * The `@stoachain/*` packages are OPTIONAL PEER DEPENDENCIES: importing this
 * subpath costs nothing (the SDK imports are lazy, inside the factory), so a
 * consumer who never talks StoaChain never installs them. Only calling
 * `createStoachainRuntime()` pulls the SDK — and a StoaChain automaton has it.
 */

/**
 * Consumer-facing knobs for {@link createStoachainRuntime}. Every field is
 * optional; an omitted field falls back to the corresponding `@stoachain/*`
 * constant. `nodeBaseUrl`, when set, builds a per-chain Pact URL against the
 * consumer's chainweb node; otherwise the runtime uses `constants.getPactUrl`.
 */
export interface StoachainRuntimeConfig {
  /** Consumer chainweb base; when set, builds getPactUrl, else uses constants.getPactUrl. */
  nodeBaseUrl?: string;
  /** Kadena network id; defaults to constants.KADENA_NETWORK. */
  networkId?: string;
  /** Kadena namespace; defaults to ouronetConstants.KADENA_NAMESPACE. */
  namespace?: string;
  /** Gas station account; defaults to ouronetConstants.STOA_AUTONOMIC_OURONETGASSTATION. */
  gasStationAccount?: string;
}

/**
 * Builds the {@link ChainRuntime} seam by wrapping the `@stoachain/*` runtime
 * once. Async because `@stoachain/*` are `type:module` ESM: every value is
 * pulled via `await import()` (a static value-import would break CJS `tsx`
 * workers), every type via `import type`.
 *
 * The imports run SEQUENTIALLY, not via `Promise.all`. The `@stoachain/*` ESM
 * modules internally `require()` one another; loading them concurrently races
 * on Node's ESM/CJS interop and throws `ERR_INTERNAL_ASSERTION` ("Cannot
 * require() ES Module ... not yet fully loaded") on Node 24+. Sequential
 * awaits let each module (and its nested requires) fully settle before the next
 * begins. This is a one-time cost at factory creation, so the latency is moot.
 */
export async function createStoachainRuntime(
  config?: StoachainRuntimeConfig,
): Promise<ChainRuntime> {
  const client = await import("@stoachain/kadena-stoic-legacy/client");
  const signing = await import("@stoachain/stoa-core/signing");
  const gas = await import("@stoachain/stoa-core/gas");
  const constants = await import("@stoachain/stoa-core/constants");
  const ouronetConstants = await import("@ouronet/ouronet-core/constants");

  const networkId = config?.networkId ?? constants.KADENA_NETWORK;
  const namespace = config?.namespace ?? ouronetConstants.KADENA_NAMESPACE;
  const gasStationAccount =
    config?.gasStationAccount ??
    ouronetConstants.STOA_AUTONOMIC_OURONETGASSTATION;

  // The Hub routed Pact IO through its co-located chainweb node via a
  // db/ssh/env probe; that host coupling is dropped here in favour of an
  // explicit `nodeBaseUrl` knob. When set, every chain's Pact URL is built
  // against it using the resolved networkId; otherwise the `@stoachain`
  // default resolver stands. `nodeBaseUrl` is captured in a const so its
  // truthiness narrows to `string` inside the closure.
  const nodeBaseUrl = config?.nodeBaseUrl;
  const getPactUrl: (chainId: string) => string = nodeBaseUrl
    ? (chainId: string) =>
        `${nodeBaseUrl}/chainweb/0.0/${networkId}/chain/${chainId}/pact`
    : constants.getPactUrl;

  return {
    Pact: client.Pact as ChainRuntime["Pact"],
    createClient: client.createClient as ChainRuntime["createClient"],
    isSignedTransaction:
      client.isSignedTransaction as ChainRuntime["isSignedTransaction"],
    universalSignTransaction:
      signing.universalSignTransaction as ChainRuntime["universalSignTransaction"],
    calculateAutoGasLimit: gas.calculateAutoGasLimit,
    anuToStoa: gas.anuToStoa,
    getPactUrl,
    networkId,
    namespace,
    gasStationAccount,
  };
}
