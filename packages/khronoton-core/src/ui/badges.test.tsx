// @vitest-environment jsdom
//
// Badges/pills suite. Opts into jsdom via the top-of-file docblock (the phase
// convention); cleanup is registered explicitly because this repo runs without
// `globals: true`. The status/mode → color+label maps are asserted as pure
// functions first (the semantic contract), then the presentational atoms are
// mounted to confirm the tokens/labels/pulse reach the DOM.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import {
  cronotonStatusStyle,
  fireStatusStyle,
  modeChipStyle,
  CronotonStatusBadge,
  FireStatusBadge,
  ModeChip,
  ServerResolverPill,
  ExternallyFireablePill,
} from "./badges.js";

afterEach(() => {
  cleanup();
});

const TEST_MODE_TITLE =
  "Test fire — recorded before the Stoicism live state was locked";

describe("cronotonStatusStyle — active gold / paused gray / completed green / error red", () => {
  it("maps active to the gold accent token so a live job reads as active", () => {
    expect(cronotonStatusStyle("active").color).toBe("var(--khr-accent)");
    expect(cronotonStatusStyle("active").label).toBe("active");
  });

  it("maps paused to the dim-text gray token so a halted job reads as inert", () => {
    expect(cronotonStatusStyle("paused").color).toBe("var(--khr-text-dim)");
    expect(cronotonStatusStyle("paused").label).toBe("paused");
  });

  it("maps completed to the success green token for a finished one-time job", () => {
    expect(cronotonStatusStyle("completed").color).toBe("var(--khr-success)");
    expect(cronotonStatusStyle("completed").background).toBe("var(--khr-success-bg)");
    expect(cronotonStatusStyle("completed").label).toBe("completed");
  });

  it("maps error to the error red token so a broken job reads as failed", () => {
    expect(cronotonStatusStyle("error").color).toBe("var(--khr-error)");
    expect(cronotonStatusStyle("error").background).toBe("var(--khr-error-bg)");
    expect(cronotonStatusStyle("error").label).toBe("error");
  });
});

describe("fireStatusStyle — success green / running amber+pulse / nothing orange / failure red", () => {
  it("maps success to success green with no pulse", () => {
    const s = fireStatusStyle("success");
    expect(s.color).toBe("var(--khr-success)");
    expect(s.label).toBe("success");
    expect(s.pulse).toBeFalsy();
  });

  it("maps running to amber AND flags pulse so an in-flight fire animates", () => {
    const s = fireStatusStyle("running");
    expect(s.color).toBe("var(--khr-amber)");
    expect(s.background).toBe("var(--khr-amber-bg)");
    expect(s.pulse).toBe(true);
  });

  it("maps nothing to the orange 'Nothing to pay' token with a visible border", () => {
    const s = fireStatusStyle("nothing");
    expect(s.color).toBe("var(--khr-nothing)");
    expect(s.label).toBe("Nothing to pay");
    expect(s.borderColor).toBeTruthy();
  });

  it("maps failure to error red with no pulse", () => {
    const s = fireStatusStyle("failure");
    expect(s.color).toBe("var(--khr-error)");
    expect(s.label).toBe("failure");
    expect(s.pulse).toBeFalsy();
  });
});

describe("modeChipStyle — LIVE success-bordered / TEST amber-bordered + provenance title", () => {
  it("maps live to a success-green border with no explanatory title", () => {
    const s = modeChipStyle("live");
    expect(s.color).toBe("var(--khr-success)");
    expect(s.borderColor).toContain("var(--khr-success)");
    expect(s.label).toBe("LIVE");
    expect(s.title).toBeUndefined();
  });

  it("maps test to an amber border and the pre-lock provenance title", () => {
    const s = modeChipStyle("test");
    expect(s.color).toBe("var(--khr-amber)");
    expect(s.borderColor).toContain("var(--khr-amber)");
    expect(s.label).toBe("TEST");
    expect(s.title).toBe(TEST_MODE_TITLE);
  });
});

describe("presentational atoms reach the DOM with the mapped token/label", () => {
  it("CronotonStatusBadge paints the mapped color and label", () => {
    render(<CronotonStatusBadge status="active" />);
    const el = screen.getByText("active");
    expect(el.style.color).toBe("var(--khr-accent)");
  });

  it("FireStatusBadge running carries the pulse animation and a keyframe", () => {
    const { container } = render(<FireStatusBadge status="running" />);
    const badge = container.querySelector('[data-pulse="true"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.style.animation).toContain("khr-pulse");
    expect(container.querySelector("style")?.textContent).toContain(
      "@keyframes khr-pulse",
    );
  });

  it("FireStatusBadge nothing renders the verbatim 'Nothing to pay' label", () => {
    render(<FireStatusBadge status="nothing" />);
    expect(screen.getByText("Nothing to pay")).toBeTruthy();
  });

  it("FireStatusBadge success renders no pulse marker", () => {
    const { container } = render(<FireStatusBadge status="success" />);
    expect(container.querySelector('[data-pulse="true"]')).toBeNull();
  });

  it("ModeChip TEST exposes the provenance title as a hover tooltip", () => {
    render(<ModeChip mode="test" />);
    const el = screen.getByText("TEST");
    expect(el.getAttribute("title")).toBe(TEST_MODE_TITLE);
  });

  it("ServerResolverPill renders the verbatim resolver caption", () => {
    render(<ServerResolverPill />);
    expect(screen.getByText("⟳ Updates server state on success")).toBeTruthy();
  });

  it("ExternallyFireablePill renders the verbatim external-fire caption", () => {
    render(<ExternallyFireablePill />);
    expect(screen.getByText("⚡ externally fireable")).toBeTruthy();
  });
});
