/**
 * Pure, client-side transaction-size estimator for the Pact editor's Tx Size
 * meter (`TxMeters.tsx`). Mirrors OuronetUI's `estimateTxSize` mechanism: it
 * assembles a real `Pact.builder` command from the current builder state,
 * serializes the `/send` request body it would produce (`{cmds:[cmd]}`), and
 * measures its UTF-8 byte length against StoaChain's fixed 2 MB Chainweb
 * ceiling.
 *
 * `@stoachain/kadena-stoic-legacy` and `@stoachain/stoa-core` are optional
 * peers (see `package.json`) — if either isn't resolvable, or the accurate
 * build throws for any other reason, this degrades to a coarser
 * `pactCode + payload` length estimate rather than throwing. The estimate is
 * a best-effort preview only: it is never signed or submitted, and is not
 * guaranteed byte-identical to what Khronoton's own executor ultimately
 * serializes (the executor synthesizes its own gas-payer signer, for one).
 */
import type { BuilderState } from "./builder-state.js";
import { builderToCommit } from "./builder-state.js";

/** Chainweb's fixed `serviceRequestSizeLimit`/`p2pRequestSizeLimit` (2 MB, network-wide). */
export const STOA_TX_BYTE_CEILING = 2 * 1024 * 1024;

/**
 * The likely-proxy-imposed soft limit (1 MB) — `TxMeters.tsx` tints the Tx
 * Size bar amber once bytes cross this, ahead of the hard 2 MB ceiling
 * turning it red.
 */
export const PROXY_SOFT_LIMIT = 1 * 1024 * 1024;

/** The same per-expected-signature byte allowance OuronetUI's `BYTES_PER_SIGNATURE` uses. */
const BYTES_PER_SIGNATURE = 140;

export interface TxSizeEstimate {
  bytes: number;
  ceiling: number;
  fraction: number;
  permille: number;
  over: boolean;
}

/**
 * The coarse fallback estimate `estimateTxSize`'s catch branch uses when the
 * accurate `Pact.builder` build throws (an optional peer isn't resolvable,
 * or any other build failure) — raw `pactCode` + JSON-stringified `payload`,
 * measured as UTF-8 bytes. Exported as its own pure function so it can be
 * tested directly and deterministically: forcing the real `catch` branch to
 * fire would require mocking `@stoachain/kadena-stoic-legacy/client`'s
 * dynamic import, which this package's real, installed copy of that
 * dependency doesn't reliably allow test-mocking of (Vitest's module mock
 * did not intercept repeated dynamic `import()` calls of the real,
 * already-resolved package reliably in this environment) — testing the
 * formula itself directly proves the one thing that actually matters (the
 * fallback computes the right number), without fighting that.
 */
export function estimateFallbackBytes(
  pactCode: string,
  payload: Record<string, unknown> | undefined,
): number {
  return new TextEncoder().encode(pactCode + JSON.stringify(payload)).length;
}

/** Estimate the serialized `/send` body size for the current builder state. */
export async function estimateTxSize(state: BuilderState): Promise<TxSizeEstimate> {
  const commit = builderToCommit(state);
  const { pactCode, config, payload, signers } = commit.envelope;

  let bytes: number;
  try {
    // SEQUENTIAL, not `Promise.all` — see `../blockchain/stoachain.ts`'s own
    // `createStoachainRuntime` for the documented reason: the `@stoachain/*`
    // ESM modules internally `require()` one another, and loading them
    // concurrently races on Node's ESM/CJS interop, throwing
    // `ERR_INTERNAL_ASSERTION` on Node 24+. This was briefly "optimized" to
    // `Promise.all` in an earlier pass of this same change (it happened to
    // pass tests on Node 22, where the race doesn't manifest) before being
    // caught and reverted — don't re-parallelize these without re-reading
    // that comment first.
    const { Pact } = await import("@stoachain/kadena-stoic-legacy/client");
    const { anuToStoa } = await import("@stoachain/stoa-core/gas");
    const { KADENA_NETWORK } = await import("@stoachain/stoa-core/constants");

    const builder = (Pact.builder.execution(pactCode || "") as any)
      .setMeta({
        senderAccount:
          state.gasPayer.type === "codex" ? (state.gasPayer.address ?? "") : "c:gas-station",
        chainId: config.chainId,
        gasLimit: config.gasLimit,
        gasPrice: anuToStoa(config.gasPrice),
        ttl: config.ttl,
      })
      .setNetworkId(KADENA_NETWORK);

    for (const [k, v] of Object.entries(payload ?? {})) {
      builder.addData(k, v);
    }

    const tx = builder.createTransaction();
    const body = JSON.stringify({ cmds: [tx] });
    bytes = new TextEncoder().encode(body).length + signers.length * BYTES_PER_SIGNATURE;
  } catch {
    bytes = estimateFallbackBytes(pactCode, payload);
  }

  return {
    bytes,
    ceiling: STOA_TX_BYTE_CEILING,
    fraction: bytes / STOA_TX_BYTE_CEILING,
    permille: (bytes / STOA_TX_BYTE_CEILING) * 1000,
    over: bytes > STOA_TX_BYTE_CEILING,
  };
}
