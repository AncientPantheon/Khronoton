// @vitest-environment jsdom
//
// StepWorkspace suite. Regression guard for the Pact-editor fill-height bug
// (docs/work/chained-builder-layout-tweaks/design.md #1): `pane="editor"` +
// `fillEditor` must make the EDITOR PANE itself a proper flex-growing item of
// its (bounded) parent, not a plain `height:"100%"` block — the textbook
// flexbox gotcha where a percentage height on a flex item doesn't reliably
// propagate the way `flex:1` does. jsdom has no real layout engine (no
// computed-style/pixel measurement reachable — see `PactCodeMirror.test.ts`'s
// own docblock for this package's established precedent), so this asserts the
// REAL rendered DOM node's own inline style, the closest reachable guard.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// Mirrors `ChainedBuilder.test.tsx`'s own convention: `PactCodeEditor` reaches
// real CodeMirror only via a dynamic `import()`, so mock it with a plain
// controlled textarea for deterministic, synchronous test rendering.
vi.mock("../PactCodeMirror.js", () => ({
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea aria-label="PACT code" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { KhronotonUiRoot } from "../KhronotonUiRoot.js";
import { StepWorkspace } from "./StepWorkspace.js";
import { makeEmptyStepState } from "../chained-builder-state.js";

afterEach(() => {
  cleanup();
});

describe("StepWorkspace — pane='editor' fillEditor", () => {
  it("makes the editor pane a flex-growing item (flex:1, minHeight:0), not a height:100% block — the fix for the fill-height bug", () => {
    render(
      <KhronotonUiRoot>
        <StepWorkspace
          step={makeEmptyStepState("single")}
          onChange={vi.fn()}
          descriptors={[]}
          earlierYieldNames={[]}
          pane="editor"
          fillEditor
        />
      </KhronotonUiRoot>,
    );

    // Walk up from the "PACT code" textarea to the editorPane wrapper — the
    // outermost div StepWorkspace itself renders for pane="editor" (3 levels
    // up: textarea -> PactCodeMirror's own root -> PactCodeEditor's body div
    // -> ... ). Rather than hard-code a fragile ancestor depth, find the
    // ancestor that actually carries `display:flex; flex-direction:column`
    // with a `gap` (editorPane's own signature), which is unique in this tree.
    const textarea = screen.getByLabelText("PACT code");
    let node: HTMLElement | null = textarea;
    let editorPane: HTMLElement | null = null;
    while (node) {
      if (node.style.flexDirection === "column" && node.style.gap === "12px") {
        editorPane = node;
        break;
      }
      node = node.parentElement;
    }

    expect(editorPane, "could not find editorPane ancestor (display:flex; flex-direction:column; gap:12px)").not.toBeNull();
    expect(editorPane!.style.height).not.toBe("100%");
    expect(editorPane!.style.flex).toBe("1 1 0%");
    expect(editorPane!.style.minHeight).toBe("0px");
  });
});

describe("StepWorkspace — pane='both' (unused by any current call site, but still a public prop value)", () => {
  it("renders BOTH the editor and fields surfaces stacked, with neither dropped by the fill-height fix", () => {
    render(
      <KhronotonUiRoot>
        <StepWorkspace
          step={makeEmptyStepState("single")}
          onChange={vi.fn()}
          descriptors={[]}
          earlierYieldNames={[]}
        />
      </KhronotonUiRoot>,
    );
    expect(screen.getByLabelText("PACT code")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Config" })).toBeTruthy();
  });
});
