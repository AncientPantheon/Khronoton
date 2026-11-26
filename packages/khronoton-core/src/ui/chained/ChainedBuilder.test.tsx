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

/** Shows the "Raw JSON" pane. With the 1200px `clientWidth` stub above, `fit`
 *  is 2 — adding a 3rd visible pane drops the oldest ("Pact code"), leaving
 *  Fields + Raw JSON on screen, which is exactly what these tests need. */
function openRawJsonPane() {
  fireEvent.click(screen.getByRole("button", { name: "Raw JSON" }));
}

describe("ChainedBuilder — Raw JSON pane: unlock / paste / import", () => {
  it("stays read-only by default, with a 'Paste / import' toggle and no textarea", () => {
    mount(makeAdapter());
    openRawJsonPane();
    expect(screen.getByRole("button", { name: "Paste / import" })).toBeTruthy();
    expect(screen.queryByLabelText("Import JSON")).toBeNull();
  });

  it("the toggle reveals the import textarea + Capture/Cancel, and Cancel returns to read-only with no state change", () => {
    mount(makeAdapter());
    openRawJsonPane();
    fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));
    expect(screen.getByLabelText("Import JSON")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Capture & parse" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Import JSON")).toBeNull();
    expect(screen.getByRole("button", { name: "Paste / import" })).toBeTruthy();
  });

  it(
    "Capture & parse on valid JSON replaces the builder's state (proven via the Name field, not just the pure function)",
    async () => {
      mount(makeAdapter());
      openRawJsonPane();
      fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));
      fireEvent.change(screen.getByLabelText("Import JSON"), {
        target: {
          value: JSON.stringify({
            name: "Imported Chain",
            steps: [{ mode: "single", pactCode: "(+ 9 9)" }],
          }),
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Capture & parse" }));

      // Capture closes the import panel back to read-only on success.
      await waitFor(() => expect(screen.queryByLabelText("Import JSON")).toBeNull(), ASYNC_TIMEOUT);

      // The Fields pane is still on screen (fit=2 kept it); open "Whole
      // cronoton" to prove the imported name actually landed in `state`.
      openWholeCronotonTab();
      expect((screen.getByPlaceholderText("StoicismRewardFlow") as HTMLInputElement).value).toBe(
        "Imported Chain",
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "Capture & parse on invalid JSON shows an error and leaves prior state untouched",
    async () => {
      mount(makeAdapter());

      // Hand-enter a name FIRST, before ever touching import — proves this
      // survives a failed capture attempt untouched.
      openWholeCronotonTab();
      fireEvent.change(screen.getByPlaceholderText("StoicismRewardFlow"), {
        target: { value: "Original Name" },
      });

      openRawJsonPane();
      fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));
      fireEvent.change(screen.getByLabelText("Import JSON"), { target: { value: "{not valid json" } });
      fireEvent.click(screen.getByRole("button", { name: "Capture & parse" }));

      await waitFor(() => expect(screen.getByText(/Invalid JSON/)).toBeTruthy(), ASYNC_TIMEOUT);
      // The import panel stays OPEN on failure (so the author can fix the
      // pasted text and retry) — it does not silently snap back to read-only.
      expect(screen.getByLabelText("Import JSON")).toBeTruthy();

      // The hand-entered name from before the failed attempt is untouched.
      expect((screen.getByPlaceholderText("StoicismRewardFlow") as HTMLInputElement).value).toBe(
        "Original Name",
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "uploading a .json file reads its text into the same textarea Capture reads from",
    async () => {
      mount(makeAdapter());
      openRawJsonPane();
      fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));

      const fileText = JSON.stringify({ name: "From file", steps: [{ mode: "single" }] });
      const file = new File([fileText], "chain.json", { type: "application/json" });
      const input = screen.getByLabelText("Upload .json file") as HTMLInputElement;
      fireEvent.change(input, { target: { files: [file] } });

      await waitFor(
        () => expect((screen.getByLabelText("Import JSON") as HTMLTextAreaElement).value).toBe(fileText),
        ASYNC_TIMEOUT,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "a failed file read shows an inline error instead of silently doing nothing (no onerror wired, no non-string-result branch)",
    async () => {
      // Stub `FileReader` for this test only — `handleImportFile` wires its own
      // `onload`/`onerror`, so a fake that always fails via `onerror` exercises
      // the error path without needing a real unreadable File (jsdom has no
      // notion of a corrupt file read). Restored in `finally` so the sibling
      // "uploading a .json file" test above keeps using the real jsdom
      // `FileReader` it depends on.
      const OriginalFileReader = global.FileReader;
      class AlwaysFailsFileReader {
        result: string | null = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsText(): void {
          queueMicrotask(() => this.onerror?.());
        }
      }
      global.FileReader = AlwaysFailsFileReader as unknown as typeof FileReader;
      try {
        mount(makeAdapter());
        openRawJsonPane();
        fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));

        const file = new File(["{}"], "chain.json", { type: "application/json" });
        const input = screen.getByLabelText("Upload .json file") as HTMLInputElement;
        fireEvent.change(input, { target: { files: [file] } });

        // The same `{importError}` paragraph the "invalid JSON" capture test
        // already asserts against — a failed read is surfaced the same way a
        // failed parse is, not a silent no-op.
        await waitFor(
          () => expect(screen.getByText(/Could not read the selected file/)).toBeTruthy(),
          ASYNC_TIMEOUT,
        );
      } finally {
        global.FileReader = OriginalFileReader;
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "a non-string FileReader result (e.g. an aborted/binary read) also surfaces an error, not a silent no-op",
    async () => {
      const OriginalFileReader = global.FileReader;
      class NonStringResultFileReader {
        result: unknown = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsText(): void {
          this.result = new ArrayBuffer(0); // never a string
          queueMicrotask(() => this.onload?.());
        }
      }
      global.FileReader = NonStringResultFileReader as unknown as typeof FileReader;
      try {
        mount(makeAdapter());
        openRawJsonPane();
        fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));

        const file = new File(["{}"], "chain.json", { type: "application/json" });
        const input = screen.getByLabelText("Upload .json file") as HTMLInputElement;
        fireEvent.change(input, { target: { files: [file] } });

        await waitFor(
          () => expect(screen.getByText(/Could not read the selected file/)).toBeTruthy(),
          ASYNC_TIMEOUT,
        );
      } finally {
        global.FileReader = OriginalFileReader;
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "Fit:1 pins the Raw JSON pane while an import is open — clicking a different pane's chip can no longer evict it with no trace",
    () => {
      mount(makeAdapter());
      // Default fit (auto) is 2 at this file's 1200px clientWidth stub —
      // showing Raw JSON first evicts "Pact code" (the comment on
      // `openRawJsonPane` above already documents this), leaving
      // visiblePanes = ["fields", "raw"].
      openRawJsonPane();

      // Force Fit:1 — with all three panes present this chip is never
      // disabled, exactly the "always clickable" case the finding calls out.
      fireEvent.click(screen.getByRole("button", { name: "1" }));

      fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));
      fireEvent.change(screen.getByLabelText("Import JSON"), {
        target: { value: '{"draft": "in progress"}' },
      });

      // The exact reachable sequence the review found: clicking a DIFFERENT
      // pane's toggle chip while mid-import, at a fit low enough that adding
      // it would otherwise slice "raw" out of `visiblePanes` entirely —
      // unmounting the whole import UI with zero on-screen warning.
      fireEvent.click(screen.getByRole("button", { name: "Pact code" }));

      // The import panel — and the draft already typed into it — must still
      // be on screen; "raw" was never evicted.
      expect((screen.getByLabelText("Import JSON") as HTMLTextAreaElement).value).toBe(
        '{"draft": "in progress"}',
      );
      expect(screen.getByRole("button", { name: "Capture & parse" })).toBeTruthy();
    },
  );

  it(
    "a successful Capture resets selection/fields-tab/sim derived from the PREVIOUS state (not just Name), and reopening import afterwards starts empty",
    async () => {
      const simulateChain = vi.fn(async (_body: unknown) => ({
        ok: true as const,
        steps: [{ stepIndex: 0, mode: "single" as const, ok: true, gasUsed: 10 }],
      }));
      mount(
        makeAdapter({
          simulateChain: simulateChain as unknown as KhronotonAdapter["simulateChain"],
        }),
      );

      // Build a state that differs from fresh-mount defaults in every field
      // `handleCaptureImport`'s success path is supposed to reset, so the
      // later assertions actually prove the reset fired — not just "those
      // fields happened to already be at their defaults".
      setPactCode("(+ 1 2)");
      fireEvent.click(screen.getByRole("button", { name: "+ Add step" })); // selected -> 1, 2 steps
      openWholeCronotonTab();
      fireEvent.click(screen.getByRole("button", { name: "Description" })); // wholeField -> "description"

      fireEvent.click(screen.getByRole("button", { name: "Simulate chain" }));
      await waitFor(() => expect(simulateChain).toHaveBeenCalledTimes(1), ASYNC_TIMEOUT);
      await waitFor(() => expect(screen.getByText(/Dry run:/)).toBeTruthy(), ASYNC_TIMEOUT);

      // Now a successful import — a minimal valid single-step document.
      openRawJsonPane();
      fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));
      fireEvent.change(screen.getByLabelText("Import JSON"), {
        target: {
          value: JSON.stringify({
            name: "Imported",
            steps: [{ mode: "single", pactCode: "(+ 9 9)" }],
          }),
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "Capture & parse" }));
      await waitFor(() => expect(screen.queryByLabelText("Import JSON")).toBeNull(), ASYNC_TIMEOUT);

      // The stale dry-run panel from BEFORE the import is gone (`sim` reset).
      expect(screen.queryByText(/Dry run:/)).toBeNull();

      // `fieldsTab` is back on "Step config" (not left on "Whole cronoton" /
      // its "Description" sub-tab) — the Name/Description fields no longer
      // render at all.
      expect(screen.queryByPlaceholderText("StoicismRewardFlow")).toBeNull();
      // ...and `selected` is back to a VALID index (0) into the new,
      // 1-step state — if it had stayed at the old index (1, now out of
      // range), the Fields pane would show "Select a step." instead of the
      // real per-step tab strip.
      expect(screen.queryByText("Select a step.")).toBeNull();
      expect(screen.getByRole("button", { name: "Gas Payer" })).toBeTruthy();

      // Reopening "Paste / import" right after a SUCCESSFUL capture starts
      // with an empty textarea and no leftover error text (only the Cancel
      // path was previously proven to clear these).
      fireEvent.click(screen.getByRole("button", { name: "Paste / import" }));
      expect((screen.getByLabelText("Import JSON") as HTMLTextAreaElement).value).toBe("");
      expect(screen.queryByText(/Invalid JSON/)).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "a pathologically deep payload — typed into the EXISTING raw-JSON payload field, not pasted via import — does not crash the live Raw JSON preview render",
    () => {
      // `jsonToChainedBuilderState` was already hardened to never throw on a
      // deep-but-valid import (it eagerly re-serializes each step's raw
      // payload/plannerParams to populate the Payload/Planner-params text,
      // so a document deep enough to overflow THAT serialize is rejected
      // with a clean parse error before it ever reaches state). But the
      // Payload tab's own raw-JSON textarea (`PayloadTab.tsx`, pre-existing,
      // nothing to do with the new import feature) stores typed text as-is
      // with no serialize step at all — so a deep value entered THIS way
      // reaches `state` untouched, and is only re-walked when `codeText`
      // (this component's own live Raw JSON preview, `JSON.stringify`d on
      // every render) tries to render it. That call had no guard at all.
      mount(makeAdapter());

      fireEvent.click(screen.getByRole("button", { name: "Payload" }));
      fireEvent.click(screen.getByRole("button", { name: "Switch to raw JSON" }));
      const deepArray = "[".repeat(50_000) + "]".repeat(50_000);
      fireEvent.change(screen.getByLabelText("Raw payload JSON (object)"), {
        target: { value: `{"deep": ${deepArray}}` },
      });

      // Must not crash the component — the render above must have survived
      // for this assertion to even run. The Raw JSON pane itself must still
      // be a normal, interactive read-only pane (not stuck mid-crash).
      openRawJsonPane();
      expect(screen.getByRole("button", { name: "Paste / import" })).toBeTruthy();
    },
    TEST_TIMEOUT,
  );
});

// All of these run at the file's fixed 1200px `clientWidth` stub (see the
// top-of-file `Object.defineProperty` — jsdom has no real ResizeObserver
// callback, so `rootWidth` is only ever set once, from that stubbed value).
// RAIL=210, GAP=14 default → availPanes = 1200-210-14 = 976.
describe("ChainedBuilder — integrator-settable pane sizing props (paneMaxWidth/paneMinWidth/railWidth)", () => {
  it("omitting all three props reproduces today's exact rail width (210px) and 2-pane width (481px) — the backward-compat pin", () => {
    mount(makeAdapter());
    expect(screen.getByTestId("chained-builder-rail").style.width).toBe("210px");
    // Default visiblePanes = ["pact", "fields"], both fit (autoFit=2 at the
    // default 360 paneMinWidth): shown=2, paneW = floor((976-14)/2) = 481,
    // under the default 600 cap so it's not clamped.
    expect(screen.getByTestId("chained-builder-pane-pact").style.flex).toBe("0 0 481px");
    // Sizing is uniform across every simultaneously-rendered pane — "fields"
    // gets the exact same paneW as "pact", not a separately-derived value.
    expect(screen.getByTestId("chained-builder-pane-fields").style.flex).toBe("0 0 481px");
  });

  it("railWidth changes BOTH the actually-rendered rail column's width AND the pane-width math — closing the landmine where only the math constant was prop-driven", () => {
    mount(makeAdapter(), { railWidth: 320 });
    expect(screen.getByTestId("chained-builder-rail").style.width).toBe("320px");
    // availPanes = 1200-320-14 = 866; autoFit still 2 (paneMinWidth default
    // 360); paneW = floor((866-14)/2) = 426 — narrower than the 481px
    // default because the math used the SAME railWidth, not a stale 210.
    expect(screen.getByTestId("chained-builder-pane-pact").style.flex).toBe("0 0 426px");
  });

  it("paneMaxWidth raises the cap once a single visible pane's share would otherwise exceed it", () => {
    mount(makeAdapter());
    // Hide "Fields" so only one pane (Pact code) is visible — its full share
    // of availPanes (976px) exceeds the default 600px cap, so the cap binds.
    fireEvent.click(screen.getByRole("button", { name: "Fields" }));
    expect(screen.getByTestId("chained-builder-pane-pact").style.flex).toBe("0 0 600px");
  });

  it("the SAME single-visible-pane scenario, with paneMaxWidth raised past availPanes, is no longer capped", () => {
    mount(makeAdapter(), { paneMaxWidth: 1200 });
    fireEvent.click(screen.getByRole("button", { name: "Fields" }));
    // PANE_MAX = max(360, 1200) = 1200; paneW = min(1200, 976) = 976 (the
    // full available width, uncapped, since 1200 > 976).
    expect(screen.getByTestId("chained-builder-pane-pact").style.flex).toBe("0 0 976px");
  });

  it("paneMaxWidth smaller than paneMinWidth doesn't invert the cap — paneW still floors at paneMinWidth, via paneW's own outer clamp (PANE_MAX carries no separate clamp of its own)", () => {
    mount(makeAdapter(), { paneMaxWidth: 100 }); // < default paneMinWidth (360)
    fireEvent.click(screen.getByRole("button", { name: "Fields" }));
    // rawShare = 976 (plenty of room) > the misconfigured PANE_MAX (100), so
    // preferredPaneW's inner Math.min clamps DOWN to 100 — but the outer
    // Math.max(PANE_MIN=360, 100) then rescues it back UP to 360. Since
    // rawShare (976) > 0 and exceeds 360, the final `Math.min(preferredPaneW,
    // rawShare)` leaves it at 360, not 100 — the cap never actually inverts.
    expect(screen.getByTestId("chained-builder-pane-pact").style.flex).toBe("0 0 360px");
  });

  it("paneMinWidth larger than the measured available width no longer overflows — it's clamped DOWN to what actually fits, not forced up past it", () => {
    // Regression for a real bug a correctness review caught: the old formula
    // (`Math.max(PANE_MIN, Math.min(PANE_MAX, rawShare || PANE_MAX))` with no
    // further check) unconditionally floors paneW at PANE_MIN regardless of
    // availPanes — so paneMinWidth=1200 here forced paneW to 1200px while
    // only 976px was actually available (availPanes = 1200-210-14), a real
    // 224px horizontal overflow on a `flex: 0 0 …px` pane (flex-shrink:0,
    // never shrinks to fit). The fix: PANE_MIN is a PREFERENCE, and must
    // never win over the ACTUAL per-pane share once that share is positive.
    mount(makeAdapter(), { paneMinWidth: 1200 });
    // autoFit = floor((976+14)/(1200+14)) = 0 -> "||1" = 1, so only the LAST
    // of the default ["pact","fields"] visible panes survives `.slice(-1)`.
    expect(screen.queryByTestId("chained-builder-pane-pact")).toBeNull();
    const railW = parseInt(screen.getByTestId("chained-builder-rail").style.width, 10);
    const paneW = parseInt(screen.getByTestId("chained-builder-pane-fields").style.flex.split(" ")[2], 10);
    expect(paneW).toBe(976); // rawShare — NOT the configured 1200.
    expect(railW + 14 + paneW).toBeLessThanOrEqual(1200);
  });

  it("a larger paneMinWidth lowers the Fit control's Auto pane count (GAP-inclusive arithmetic, not a GAP-naive approximation)", () => {
    mount(makeAdapter());
    expect(screen.getByRole("button", { name: "Auto (2)" })).toBeTruthy();
    cleanup();

    // paneMinWidth=488 is chosen so the real formula and a plausible
    // GAP-NAIVE mutant (`floor(availPanes / PANE_MIN)` instead of
    // `floor((availPanes+GAP) / (PANE_MIN+GAP))`) actually DISAGREE here:
    // real: floor((976+14)/(488+14)) = floor(990/502) = 1.
    // GAP-naive: floor(976/488) = 2 — a different result, so this breakpoint
    // genuinely pins the GAP-inclusive formula, not just "some monotonic
    // decrease somewhere between 360 and a big number."
    mount(makeAdapter(), { paneMinWidth: 488 });
    expect(screen.getByRole("button", { name: "Auto (1)" })).toBeTruthy();
  });

  it("never renders a pane wider than the measured width can hold, at custom prop values — the no-horizontal-scroll invariant", () => {
    for (const props of [
      { paneMaxWidth: 2000, paneMinWidth: 100, railWidth: 50 },
      // railWidth + GAP lands EXACTLY at the stubbed 1200px clientWidth
      // (1186+14=1200) — availPanes bottoms out at its Math.max(0, …) floor
      // of 0, the tightest edge reachable WITHOUT railWidth alone exceeding
      // the mount's own width (that further edge is a deliberately
      // out-of-scope misconfiguration — see the comment at `paneW`'s
      // definition in ChainedBuilder.tsx).
      { railWidth: 1186 },
      // paneMinWidth alone exceeds availPanes (976 at default railWidth) —
      // the exact HIGH-severity regression fixed above, re-checked here as
      // part of the general invariant sweep too.
      { paneMinWidth: 1200 },
    ]) {
      mount(makeAdapter(), props);
      const railW = parseInt(screen.getByTestId("chained-builder-rail").style.width, 10);
      const paneEls = [
        screen.queryByTestId("chained-builder-pane-pact"),
        screen.queryByTestId("chained-builder-pane-fields"),
      ].filter((el): el is HTMLElement => el !== null);
      const paneWidths = paneEls.map((el) => parseInt(el.style.flex.split(" ")[2], 10));
      const totalWidth = railW + 14 + paneWidths.reduce((sum, w) => sum + w, 0) + (paneWidths.length - 1) * 14;
      expect(totalWidth, `overflow at props=${JSON.stringify(props)}`).toBeLessThanOrEqual(1200);
      cleanup();
    }
  });
});
