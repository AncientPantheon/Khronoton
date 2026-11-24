// @vitest-environment jsdom
//
// ChainedBuilder commit-routing suite. Opts into jsdom via the top-of-file
// docblock (the global vitest env stays `node` for the engine/handler suites).
// `handleCommit` branches on `isSingleStepChain(state)`: exactly one `single`
// step with no single-tx variant routes through `adapter.commit` (a plain
// `CommitBody`); anything else routes through `adapter.commitChain` (a
// `ChainCommitBody`). `isSingleStepChain` itself is unit-tested in isolation
// (`chained-builder-state.test.ts`) — this suite proves the COMPONENT actually
// wires that predicate's result to the right adapter call, mounting a real
// provider over a fake adapter exactly as `Builder.test.tsx` does for the
// sibling single-tx screen.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

// The live gas floor's optional peer, mocked so `useLiveGasFloor()` resolves a
// fixed value instead of pulling the real WASM/crypto runtime (mirrors
// `Builder.test.tsx`'s own `@stoachain/*` module-mock idiom).
vi.mock("@stoachain/stoa-core/gas", () => ({ minGasPriceAnu: vi.fn(() => 12345) }));

// `PactCodeEditor` reaches real CodeMirror only via a dynamic `import()`
// (`PactCodeEditor.tsx`'s documented SSR/jsdom seam), rendering the plain
// `<textarea aria-label="PACT code">` fallback until that promise resolves.
// `PactCodeEditor.test.tsx` proves a FIRST synchronous render always observes
// that fallback — but the lazy component (and its resolved-module cache) is
// created ONCE at `PactCodeEditor.tsx`'s module-eval time and shared across
// every test in this file, so by the second test the import is already
// settled and CodeMirror mounts immediately, with no jsdom-measurable,
// reliably interactive surface. Mocking the lazy-loaded module itself keeps
// the "PACT code" textarea contract stable across every test here, the same
// way the `@stoachain/*` mock above keeps `useLiveGasFloor()` deterministic.
vi.mock("../PactCodeMirror.js", () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="PACT code" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { KhronotonProvider } from "../../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../../provider/adapter.js";
import { KhronotonUiRoot } from "../KhronotonUiRoot.js";
import { ChainedBuilder } from "./ChainedBuilder.js";
import { builderToCommit, makeEmptyBuilderState } from "../builder-state.js";
import type { Access } from "../access.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ADMIN: Access = { tier: "admin", email: "ancient@holdings.test" };

const DESCRIPTORS = [
  { publicKey: "k:alice", display: "derived" as const },
  { publicKey: "k:bob", display: "foreign" as const },
];

/** A complete adapter fake, same pattern as `Builder.test.tsx`'s `makeAdapter`
 *  (16 required methods, inert except the overridden ones). `commitChain` /
 *  `simulateChain` are OPTIONAL fields on `KhronotonAdapter` (not in
 *  `REQUIRED_METHODS`) — omitted unless a test explicitly supplies one, so the
 *  `!adapter.commitChain` guard test can exercise the true-omitted case. */
function makeAdapter(overrides: Partial<KhronotonAdapter> = {}): KhronotonAdapter {
  const inert = () => vi.fn(async () => ({ ok: true }));
  return {
    list: inert(),
    get: inert(),
    fires: inert(),
    signers: vi.fn(async () => ({ ok: true, signers: DESCRIPTORS })),
    resolvers: vi.fn(async () => ({ ok: true, resolvers: [] })),
    commit: inert(),
    edit: inert(),
    pause: inert(),
    resume: inert(),
    delete: inert(),
    simulate: inert(),
    executeNow: inert(),
    trigger: inert(),
    startBatch: inert(),
    getBatch: inert(),
    cancelBatch: inert(),
    recover: inert(),
    ...overrides,
  } as unknown as KhronotonAdapter;
}

function mount(adapter: KhronotonAdapter, props: Partial<Parameters<typeof ChainedBuilder>[0]> = {}) {
  return render(
    <KhronotonProvider adapter={adapter}>
      <KhronotonUiRoot>
        <ChainedBuilder access={ADMIN} {...props} />
      </KhronotonUiRoot>
    </KhronotonProvider>,
  );
}

/** Sets the currently-selected step's Pact code via the (mocked) editor's
 *  `aria-label="PACT code"` surface — the same contract `PactCodeEditor.tsx`
 *  documents for its real fallback `<textarea>`. */
function setPactCode(code: string) {
  fireEvent.change(screen.getByLabelText("PACT code"), { target: { value: code } });
}

/** Waits for the signer descriptors, opens the step's Gas Payer tab (its
 *  `tab` state persists across step switches — StepWorkspace is not remounted
 *  per step — so this only needs to run once per test), and picks a signing
 *  key. Clears BOTH the gas-payer gate and the signer gate (the synthesized
 *  gas-payer signer counts toward `effectiveSignerCount`), mirroring
 *  `Builder.test.tsx`'s own create-round-trip sequence. */
async function setGasStationKey(key: string) {
  await screen.findByRole("option", { name: key }).catch(() => null);
  fireEvent.click(screen.getByRole("button", { name: "Gas Payer" }));
  await waitFor(() => expect(screen.getByRole("option", { name: key })).toBeTruthy());
  fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
    target: { value: key },
  });
}

describe("ChainedBuilder — single-step, single-mode, no-variant chain commits via adapter.commit", () => {
  it("routes to adapter.commit (never adapter.commitChain) with the plain single-cronoton body", async () => {
    const commit = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_single",
      nextFireAt: null,
    }));
    const commitChain = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_chain",
      nextFireAt: null,
      stepIds: [],
    }));
    const onDone = vi.fn();
    const adapter = makeAdapter({
      commit: commit as unknown as KhronotonAdapter["commit"],
      commitChain: commitChain as unknown as KhronotonAdapter["commitChain"],
    });
    mount(adapter, { onDone });

    // `isSingleStepChain` requires exactly one `single` step and no variant —
    // the DEFAULT state (`makeEmptyChainedBuilderState()`) already satisfies
    // that; only the commit gate's own required fields need filling in.
    setPactCode("(+ 1 2)");
    fireEvent.change(screen.getByPlaceholderText("StoicismRewardFlow"), {
      target: { value: "Nightly chain" },
    });
    await setGasStationKey("k:alice");

    fireEvent.click(screen.getByRole("button", { name: "Create cronoton" }));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(commitChain).not.toHaveBeenCalled();

    // The wire body is exactly what the single-tx serializer produces from the
    // edited step — proving the body shape, not just the branch taken.
    const expected = builderToCommit({
      ...makeEmptyBuilderState(),
      name: "Nightly chain",
      pactCode: "(+ 1 2)",
      gasPayer: { type: "gas-station", signingKey: "k:alice" },
    });
    expect(commit.mock.calls[0][0]).toEqual(expected);

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("cr_single"));
  });
});

describe("ChainedBuilder — a 2-step chain commits via adapter.commitChain", () => {
  it("routes to adapter.commitChain (never adapter.commit) once a second step is added", async () => {
    const commit = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_single",
      nextFireAt: null,
    }));
    const commitChain = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_chain",
      nextFireAt: null,
      stepIds: ["s1", "s2"],
    }));
    const onDone = vi.fn();
    const adapter = makeAdapter({
      commit: commit as unknown as KhronotonAdapter["commit"],
      commitChain: commitChain as unknown as KhronotonAdapter["commitChain"],
    });
    mount(adapter, { onDone });

    // Step 1 (selected by default).
    setPactCode("(+ 1 2)");
    fireEvent.change(screen.getByPlaceholderText("StoicismRewardFlow"), {
      target: { value: "Two-step chain" },
    });
    await setGasStationKey("k:alice");

    // Adding a second step flips `isSingleStepChain` false (2 steps) AND moves
    // `selected` onto the new step (the component's own `addStep` behaviour).
    fireEvent.click(screen.getByRole("button", { name: "+ Add step" }));

    // Step 2's own Pact code + signing key — the chain gate validates EVERY
    // step, not just the first.
    setPactCode("(+ 3 4)");
    fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
      target: { value: "k:bob" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create chained cronoton" }));

    await waitFor(() => expect(commitChain).toHaveBeenCalledTimes(1));
    expect(commit).not.toHaveBeenCalled();
    expect(commitChain.mock.calls[0][0]).toMatchObject({
      name: "Two-step chain",
      steps: [
        expect.objectContaining({ mode: "single", pactCode: "(+ 1 2)" }),
        expect.objectContaining({ mode: "single", pactCode: "(+ 3 4)" }),
      ],
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("cr_chain"));
  });
});

describe("ChainedBuilder — missing adapter.commitChain on a real chain", () => {
  it("warns via window.alert instead of throwing when the backend omits commitChain", async () => {
    const commit = vi.fn(async (_body: unknown) => ({
      ok: true as const,
      codexCronotonId: "cr_single",
      nextFireAt: null,
    }));
    const onDone = vi.fn();
    // Deliberately NO `commitChain` override — `makeAdapter`'s base object never
    // sets it, so `adapter.commitChain` is `undefined` (the optional-field case
    // the finding calls out).
    const adapter = makeAdapter({ commit: commit as unknown as KhronotonAdapter["commit"] });
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    mount(adapter, { onDone });

    setPactCode("(+ 1 2)");
    fireEvent.change(screen.getByPlaceholderText("StoicismRewardFlow"), {
      target: { value: "No commitChain" },
    });
    await setGasStationKey("k:alice");

    fireEvent.click(screen.getByRole("button", { name: "+ Add step" }));
    setPactCode("(+ 3 4)");
    fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
      target: { value: "k:bob" },
    });

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Create chained cronoton" })),
    ).not.toThrow();

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        "This backend does not support chained cronotons (no commitChain).",
      ),
    );
    expect(commit).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
