// @vitest-environment jsdom
//
// RawJsonViewer suite. Mirrors PactCodeEditor.test.tsx's own contract exactly:
// the real CodeMirror path needs browser DOM measurement jsdom does not
// provide, so the value/fallback contract is exercised through the documented
// `forceFallback` seam, and the SSR path is pinned with `renderToStaticMarkup`.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { KhronotonUiRoot } from "./KhronotonUiRoot.js";
import { RawJsonViewer } from "./RawJsonViewer.js";

afterEach(() => {
  cleanup();
});

describe("RawJsonViewer", () => {
  it("shows the given value via the read-only fallback <pre>, proving value flows into the surface", () => {
    render(
      <KhronotonUiRoot>
        <RawJsonViewer value={'{\n  "name": "x"\n}'} forceFallback />
      </KhronotonUiRoot>,
    );
    const pre = screen.getByTestId("chained-builder-raw-json-pre");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toBe('{\n  "name": "x"\n}');
  });

  it("preserves real newlines verbatim — no reformatting of an already pretty-printed value", () => {
    render(
      <KhronotonUiRoot>
        <RawJsonViewer value={'{\n  "a": 1,\n  "b": 2\n}'} forceFallback />
      </KhronotonUiRoot>,
    );
    const pre = screen.getByTestId("chained-builder-raw-json-pre");
    expect(pre.textContent).toContain("\n");
    expect(pre.textContent).toMatch(/\{\n {2}"a": 1,\n {2}"b": 2\n\}/);
  });

  it("server-renders the plain-<pre> fallback without touching window/CodeMirror", () => {
    // No forceFallback here: the mounted-gate keeps first paint on the
    // fallback during a server render (no effects run), so SSR never loads
    // CodeMirror — mirrors PactCodeEditor.test.tsx's own equivalent test.
    const html = renderToStaticMarkup(
      <KhronotonUiRoot>
        <RawJsonViewer value='{"server":"safe"}' />
      </KhronotonUiRoot>,
    );
    expect(html).toContain("<pre");
    expect(html).toContain("server");
  });

  it("mounts on the client without throwing even when CodeMirror is allowed to load", () => {
    expect(() =>
      render(
        <KhronotonUiRoot>
          <RawJsonViewer value="{}" />
        </KhronotonUiRoot>,
      ),
    ).not.toThrow();
    // The lazy CodeMirror is still resolving at this synchronous point, so
    // the Suspense fallback <pre> is what this observes.
    expect(screen.getByTestId("chained-builder-raw-json-pre")).toBeTruthy();
  });
});
