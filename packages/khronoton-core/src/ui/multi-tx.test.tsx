// @vitest-environment jsdom
//
// Multi-tx cell suite. Pins the GENERIC seam (REQ-D08/G04): the default
// renderer shows an ordinary single-tx request key / error — NO baked-in
// pool-payout/N-of-18 breakdown — and `<FireTxCell>` delegates to an injected
// `config.renderMultiTx` only when one is provided AND the fire is multi-tx
// shaped. The Hub's `PayoutTxBreakdown` is the consumer's renderer, not shipped.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

import { FireTxCell, DefaultSingleTx, isMultiTx } from "./multi-tx.js";
import type { CodexCronotonFireRow, FireTxKey } from "../server/index.js";

afterEach(() => {
  cleanup();
});

const BASE = "https://explorer.stoachain.com/transactions";

function makeFire(overrides: Partial<CodexCronotonFireRow> = {}): CodexCronotonFireRow {
  return {
    id: "fire_1",
    firedAt: "2026-07-13T12:00:00.000Z",
    status: "success",
    requestKey: "rk_single_abc",
    chainId: "0",
    errorMessage: null,
    chainResponse: null,
    definitionFingerprint: "fp0",
    mode: "live",
    recoveredAt: null,
    txKeys: [],
    ...overrides,
  };
}

const burn: FireTxKey = { kind: "burn", chainId: "3", requestKey: "rk_burn_3", ok: true };
const bulk: FireTxKey = { kind: "bulk", chainId: "0", requestKey: "rk_bulk_0", ok: true };

describe("isMultiTx", () => {
  it("is false for an ordinary single-tx fire (no tx keys)", () => {
    expect(isMultiTx(makeFire({ txKeys: [] }))).toBe(false);
  });

  it("is false when the only tx keys are bulk transfers", () => {
    // A lone bulk transfer is still the ordinary single-tx shape, not a breakdown.
    expect(isMultiTx(makeFire({ txKeys: [bulk] }))).toBe(false);
  });

  it("is true when a non-bulk (burn/continuation) step is present", () => {
    expect(isMultiTx(makeFire({ txKeys: [burn, bulk] }))).toBe(true);
  });
});

describe("<DefaultSingleTx>", () => {
  it("renders the request key as an explorer step link for a successful fire", () => {
    render(<DefaultSingleTx fire={makeFire({ requestKey: "rk_single_abc" })} base={BASE} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`${BASE}/rk_single_abc`);
    expect(link.textContent).toContain("rk_single_abc");
  });

  it("renders the error message (no link) for a failed fire", () => {
    render(
      <DefaultSingleTx
        fire={makeFire({ status: "failure", requestKey: null, errorMessage: "gas underpriced" })}
        base={BASE}
      />,
    );
    expect(screen.getByText("gas underpriced")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("<FireTxCell>", () => {
  it("renders the default single-tx display when no renderMultiTx is provided", () => {
    render(<FireTxCell fire={makeFire({ requestKey: "rk_single_abc" })} base={BASE} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe(`${BASE}/rk_single_abc`);
  });

  it("renders the default single-tx even for a multi-tx fire when no renderMultiTx is registered", () => {
    // Without a host-supplied breakdown, a multi-tx fire falls back to the key link —
    // the package never ships the pool-payout breakdown itself.
    render(<FireTxCell fire={makeFire({ txKeys: [burn, bulk] })} base={BASE} />);
    expect(screen.queryByText("BREAKDOWN")).toBeNull();
    expect(screen.getByRole("link")).toBeTruthy();
  });

  it("delegates to an injected renderMultiTx when the fire is multi-tx shaped", () => {
    const fire = makeFire({ txKeys: [burn, bulk] });
    const renderMultiTx = (f: CodexCronotonFireRow) => <span>BREAKDOWN {f.txKeys.length}</span>;
    render(<FireTxCell fire={fire} base={BASE} renderMultiTx={renderMultiTx} />);
    expect(screen.getByText("BREAKDOWN 2")).toBeTruthy();
  });

  it("ignores renderMultiTx for a single-tx fire and shows the default key link", () => {
    // A registered breakdown must not hijack ordinary single-tx fires.
    const renderMultiTx = () => <span>BREAKDOWN</span>;
    render(
      <FireTxCell fire={makeFire({ requestKey: "rk_single_abc" })} base={BASE} renderMultiTx={renderMultiTx} />,
    );
    expect(screen.queryByText("BREAKDOWN")).toBeNull();
    expect(screen.getByRole("link").getAttribute("href")).toBe(`${BASE}/rk_single_abc`);
  });
});
