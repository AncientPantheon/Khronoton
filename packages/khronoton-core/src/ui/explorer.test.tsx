// @vitest-environment jsdom
//
// Explorer-link helper suite. Pins the pure URL builder (REQ-D10 shape
// `${base}/${encodeURIComponent(requestKey)}`) and the presentational
// `<ExplorerLink>` new-tab link (REQ-G02 — base is the config.explorerBase knob).
// jsdom docblock + explicit cleanup mirror the phase test convention.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { explorerUrl, ExplorerLink } from "./explorer.js";

afterEach(() => {
  cleanup();
});

describe("explorerUrl", () => {
  it("joins the base and request key with a single slash", () => {
    // The deep link is base + '/' + key; a plain key passes through unescaped.
    expect(explorerUrl("https://explorer.stoachain.com/transactions", "AbC-123_xyz")).toBe(
      "https://explorer.stoachain.com/transactions/AbC-123_xyz",
    );
  });

  it("percent-encodes reserved characters so the key can never break the path", () => {
    // A key with '/', space and '+' must not alter the URL's path structure.
    expect(explorerUrl("https://x.io/tx", "a/b c+d")).toBe("https://x.io/tx/a%2Fb%20c%2Bd");
  });
});

describe("<ExplorerLink>", () => {
  it("links to the explorer URL for the given base and request key", () => {
    render(<ExplorerLink base="https://x.io/tx" requestKey="rk_42" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://x.io/tx/rk_42");
  });

  it("opens in a new tab with a safe rel so the opener is not exposed", () => {
    render(<ExplorerLink base="https://x.io/tx" requestKey="rk_42" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("labels the affordance 'explorer' with the 'chain explorer' hover title", () => {
    render(<ExplorerLink base="https://x.io/tx" requestKey="rk_42" />);
    const link = screen.getByRole("link");
    expect(link.textContent).toContain("explorer");
    expect(link.getAttribute("title")).toBe("chain explorer");
  });
});
