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

// jsdom implements neither `ResizeObserver` nor real layout (`clientWidth` is
// always 0), but `ChainedBuilder`'s filmstrip sizes its panes from a
// `ResizeObserver`-measured width — with both absent, its `fit` calculation
// degenerates to 1 and `renderedPanes` (the LAST `fit` visible panes) renders
// only "Fields", never "Pact code", which a real browser never does (it
// always has both APIs). Stubbing a realistic desktop width here is a test-
// environment fix, not a production one — `ChainedBuilder.tsx`'s own
// behavior/shape is unchanged; this just gives jsdom the measurement a real
// browser already provides for free.
class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
// jsdom has no ResizeObserver at runtime, but the DOM lib types declare it
// globally, so this plain assignment type-checks without a suppression —
// it unblocks ChainedBuilder.tsx's `typeof ResizeObserver === "undefined"`
// guard for this test file only.
global.ResizeObserver = FakeResizeObserver;
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  value: 1200, // enough for "Pact code" + "Fields" to both fit (PANE_MIN=360, RAIL=210, GAP=14)
});

import { KhronotonProvider } from "../../provider/KhronotonProvider.js";
import type { KhronotonAdapter } from "../../provider/adapter.js";
import { KhronotonUiRoot } from "../KhronotonUiRoot.js";
import { ChainedBuilder } from "./ChainedBuilder.js";
import { builderToCommit, makeEmptyBuilderState } from "../builder-state.js";
import type { Access } from "../access.js";

// Full-suite runs (100+ files, heavy parallel load) occasionally need more
// than testing-library's 1000ms waitFor default — this file mounts a
// ResizeObserver-driven layout + nested tab state on top of the usual async
// commit/simulate chain, so give every wait here real headroom rather than
// relying on luck. IMPORTANT: this must stay comfortably BELOW each test's
// own `it(..., TEST_TIMEOUT)` third argument below — vitest's own per-test
// timeout (default 5000ms) wraps the whole test independently of any
// individual `waitFor`'s internal polling timeout, and the two racing at the
// same value is exactly what caused an intermittent full-suite-only flake
// here (a `waitFor({timeout:5000})` and the test's own unwidened 5000ms
// default could each "win" depending on scheduling).
const ASYNC_TIMEOUT = { timeout: 8000 };
const TEST_TIMEOUT = 15000;

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

/** Opens the Fields pane's "Whole cronoton" tab (Name/Description/Schedule) —
 *  it defaults to "Step config" (the dominant surface), so Name must be
 *  reached explicitly. Matched by regex: the tab's own label grows a
 *  trailing "•" while `wholeIncomplete` (no name yet), which would break an
 *  exact-string accessible-name match. */
function openWholeCronotonTab() {
  fireEvent.click(screen.getByRole("button", { name: /Whole cronoton/ }));
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
  await waitFor(() => expect(screen.getByRole("option", { name: key })).toBeTruthy(), ASYNC_TIMEOUT);
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
    await setGasStationKey("k:alice");
    // Name lives on the Fields pane's "Whole cronoton" tab (not the default
    // "Step config" tab) — switch to it only after the per-step Gas Payer
    // tab (a DIFFERENT, nested tab strip inside "Step config") is done with.
    openWholeCronotonTab();
    fireEvent.change(screen.getByPlaceholderText("StoicismRewardFlow"), {
      target: { value: "Nightly chain" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create cronoton" }));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1), ASYNC_TIMEOUT);
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

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("cr_single"), ASYNC_TIMEOUT);
  }, TEST_TIMEOUT);
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

    // Step 1 (selected by default). Stay on the Fields pane's default
    // "Step config" tab for every per-step field — it's a nested tab strip
    // (Config/Payload/Gas Payer/Signatures) independent of `selected`, so
    // adding a step and switching to it never disturbs it.
    setPactCode("(+ 1 2)");
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

    // Name lives on the Fields pane's "Whole cronoton" tab — switch to it
    // only now that every per-step field is done.
    openWholeCronotonTab();
    fireEvent.change(screen.getByPlaceholderText("StoicismRewardFlow"), {
      target: { value: "Two-step chain" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Create chained cronoton" }));

    await waitFor(() => expect(commitChain).toHaveBeenCalledTimes(1), ASYNC_TIMEOUT);
    expect(commit).not.toHaveBeenCalled();
    expect(commitChain.mock.calls[0][0]).toMatchObject({
      name: "Two-step chain",
      steps: [
        expect.objectContaining({ mode: "single", pactCode: "(+ 1 2)" }),
        expect.objectContaining({ mode: "single", pactCode: "(+ 3 4)" }),
      ],
    });

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("cr_chain"), ASYNC_TIMEOUT);
  }, TEST_TIMEOUT);
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
    await setGasStationKey("k:alice");

    fireEvent.click(screen.getByRole("button", { name: "+ Add step" }));
    setPactCode("(+ 3 4)");
    fireEvent.change(screen.getByLabelText("Signing Key (DALOS.GAS_PAYER capability)"), {
      target: { value: "k:bob" },
    });

    // Name lives on the Fields pane's "Whole cronoton" tab — switch to it
    // only now that every per-step field is done.
    openWholeCronotonTab();
    fireEvent.change(screen.getByPlaceholderText("StoicismRewardFlow"), {
      target: { value: "No commitChain" },
    });

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Create chained cronoton" })),
    ).not.toThrow();

    await waitFor(
      () =>
        expect(alertSpy).toHaveBeenCalledWith(
          "This backend does not support chained cronotons (no commitChain).",
        ),
      ASYNC_TIMEOUT,
    );
    expect(commit).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);
});
