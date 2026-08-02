// @vitest-environment jsdom
//
// PactCodeEditor suite. Opts into jsdom via the top-of-file docblock. The
// editor's real CodeMirror path needs browser DOM measurement jsdom does not
// provide, so the value/onChange/Clear contract is exercised through the
// documented `forceFallback` seam (the plain <textarea>), and the SSR path is
// pinned with `renderToStaticMarkup`.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { KhronotonUiRoot } from "./KhronotonUiRoot.js";
import { PactCodeEditor } from "./PactCodeEditor.js";
import type { PactCodeEditorProps } from "./PactCodeEditor.js";

afterEach(() => {
  cleanup();
});

function renderEditor(props: Partial<PactCodeEditorProps> = {}) {
  const onChange = props.onChange ?? vi.fn();
  render(
    <KhronotonUiRoot>
      <PactCodeEditor value="(module m)" onChange={onChange} forceFallback {...props} />
    </KhronotonUiRoot>,
  );
  return { onChange };
}

describe("PactCodeEditor", () => {
  it("renders the 'PACT Code Editor' header so the top editor strip is labelled", () => {
    renderEditor();
    expect(screen.getByText("PACT Code Editor")).toBeTruthy();
  });

  it("shows the current pact source, proving value flows into the editor surface", () => {
    renderEditor({ value: "(defun foo () 1)" });
    const textarea = screen.getByLabelText("PACT code") as HTMLTextAreaElement;
    expect(textarea.value).toBe("(defun foo () 1)");
  });

  it("emits the edited source through onChange when the user types", () => {
    const { onChange } = renderEditor({ value: "" });
    const textarea = screen.getByLabelText("PACT code");
    fireEvent.change(textarea, { target: { value: "(+ 1 2)" } });
    expect(onChange).toHaveBeenCalledWith("(+ 1 2)");
  });

  it("renders a Clear control that invokes onClear so the pane can be reset", () => {
    const onClear = vi.fn();
    renderEditor({ onClear });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("omits the Clear control when no onClear handler is supplied", () => {
    renderEditor({ onClear: undefined });
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("applies the requested height to the editor body so the pane sizes correctly", () => {
    renderEditor({ height: 320 });
    const textarea = screen.getByLabelText("PACT code") as HTMLTextAreaElement;
    expect(textarea.style.height).toBe("320px");
  });

  it("server-renders the plain-textarea fallback without touching window/CodeMirror", () => {
    // No forceFallback here: the mounted-gate keeps first paint on the fallback
    // during a server render (no effects run), so SSR never loads CodeMirror.
    const html = renderToStaticMarkup(
      <KhronotonUiRoot>
        <PactCodeEditor value="(server-safe)" onChange={() => {}} />
      </KhronotonUiRoot>,
    );
    expect(html).toContain("PACT Code Editor");
    expect(html).toContain("(server-safe)");
    expect(html).toContain("<textarea");
  });

  it("mounts on the client without throwing even when CodeMirror is allowed to load", () => {
    expect(() =>
      render(
        <KhronotonUiRoot>
          <PactCodeEditor value="(x)" onChange={() => {}} />
        </KhronotonUiRoot>,
      ),
    ).not.toThrow();
    // The lazy CodeMirror is still resolving, so the Suspense fallback textarea
    // is what a synchronous render observes — the header is always present.
    expect(screen.getByText("PACT Code Editor")).toBeTruthy();
  });

  it("renders the subBar slot content when supplied, e.g. a tx-size/gas meter", () => {
    renderEditor({ subBar: <span>METER</span> });
    expect(screen.getByText("METER")).toBeTruthy();
    expect(screen.getByTestId("pact-editor-subbar")).toBeTruthy();
  });

  it("renders no subBar wrapper at all when subBar is omitted", () => {
    // Asserting on DOM structure (the wrapper's own testid), not on text
    // that was never supplied in this render — a version that renders the
    // wrapper div unconditionally (even with nothing inside it) would still
    // pass a text-only assertion here, but fails this one correctly.
    renderEditor();
    expect(screen.queryByTestId("pact-editor-subbar")).toBeNull();
  });
});
