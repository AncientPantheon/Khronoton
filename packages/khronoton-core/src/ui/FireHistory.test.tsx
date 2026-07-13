// @vitest-environment jsdom
//
// `<FireHistory>` — the detail-screen fire-history card (parity inventory §2):
// heading + TEST/LIVE legend, the 8-column table (Fired / Mode / Status /
// Request key-error / Result tooltip / Chain / Definition drift / Explorer),
// the 50-per-page pager, and the wired recover affordance (REQ-G09). Mounts the
// REAL `<KhronotonProvider>` (so `useKhronoton().config` + the fires hook read a
// live context) over a fake 16-method adapter whose `fires` slices a seeded row
// source and whose `recover` mutates it, so a recover→refetch genuinely flips a
// failed fire to success. jsdom docblock + explicit cleanup per phase convention.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { KhronotonProvider } from "../provider/KhronotonProvider.js";
import type { KhronotonAdapter, FiresView } from "../provider/adapter.js";
import type { CodexCronotonFireRow } from "../server/index.js";
import type { Access } from "./access.js";
import { FireHistory } from "./FireHistory.js";

afterEach(() => {
  cleanup();
});

const ADMIN: Access = { tier: "admin", email: "ancient@ancientholdings.eu" };
const PUBLIC: Access = { tier: "logged-out" };

function makeFire(
  partial: Partial<CodexCronotonFireRow> & { id: string },
): CodexCronotonFireRow {
  return {
    id: partial.id,
    firedAt: partial.firedAt ?? "2026-07-13T00:00:00.000Z",
    status: partial.status ?? "success",
    requestKey: partial.requestKey ?? null,
    chainId: partial.chainId ?? "0",
    errorMessage: partial.errorMessage ?? null,
    chainResponse: "chainResponse" in partial ? partial.chainResponse : null,
    definitionFingerprint: partial.definitionFingerprint ?? null,
    mode: partial.mode ?? "live",
    recoveredAt: partial.recoveredAt ?? null,
    txKeys: partial.txKeys ?? [],
  };
}

/** A full 16-method adapter whose `fires` slices `getRows()` and whose `recover`
 *  runs `onRecover` (so a test can flip a failed row to success). */
function firesAdapter(
  getRows: () => CodexCronotonFireRow[],
  onRecover?: (fireId: string) => void,
): KhronotonAdapter {
  const stub = vi.fn(async () => ({ ok: true }));
  const fires = vi.fn(
    async (q: { id: string; limit?: number; offset?: number }): Promise<FiresView> => {
      const all = getRows();
      const start = q.offset ?? 0;
      const lim = q.limit ?? 50;
      return {
        ok: true,
        fires: all.slice(start, start + lim),
        total: all.length,
        limit: lim,
        offset: start,
      };
    },
  );
  const recover = vi.fn(async (_id: string, fireId: string, requestKey: string) => {
    onRecover?.(fireId);
    return { ok: true as const, fireId, requestKey };
  });
  return {
    list: stub,
    get: stub,
    fires,
    signers: stub,
    commit: stub,
    edit: stub,
    pause: stub,
    resume: stub,
    delete: stub,
    simulate: stub,
    executeNow: stub,
    trigger: stub,
    startBatch: stub,
    getBatch: stub,
    cancelBatch: stub,
    recover,
  } as unknown as KhronotonAdapter;
}

interface MountOpts {
  access?: Access;
  showMode?: boolean;
  pageSize?: number;
  promptRequestKey?: (fire: CodexCronotonFireRow) => string | null;
}

function mount(adapter: KhronotonAdapter, opts: MountOpts = {}) {
  return render(
    <KhronotonProvider adapter={adapter} showMode={opts.showMode} pageSize={opts.pageSize}>
      <FireHistory id="c1" access={opts.access ?? ADMIN} promptRequestKey={opts.promptRequestKey} />
    </KhronotonProvider>,
  );
}

describe("<FireHistory> — heading + rows", () => {
  it("renders the heading with the total and the loaded rows", async () => {
    const rows = [
      makeFire({ id: "f0", status: "success", requestKey: "rk0" }),
      makeFire({ id: "f1", status: "failure", errorMessage: "gas station under-funded" }),
      makeFire({ id: "f2", status: "nothing" }),
    ];
    mount(firesAdapter(() => rows));

    // The heading pins the fires total so a viewer sees how many fires exist.
    expect(await screen.findByText("Fire history (3)")).toBeTruthy();
    // A nothing-fire reads "Nothing to pay" twice: the status badge AND the
    // request-key cell (the cell shows the skip label, never a raw key/error).
    expect(screen.getAllByText("Nothing to pay")).toHaveLength(2);
  });

  it("renders the empty message when a cronoton has never fired", async () => {
    mount(firesAdapter(() => []));

    expect(await screen.findByText("Fire history (0)")).toBeTruthy();
    expect(screen.getByText("No fires yet.")).toBeTruthy();
  });
});

describe("<FireHistory> — mode column gating (REQ-G03)", () => {
  it("shows the TEST/LIVE legend and Mode column when showMode is on", async () => {
    const rows = [
      makeFire({ id: "f0", mode: "live", requestKey: "rk0" }),
      makeFire({ id: "f1", mode: "test", requestKey: "rk1" }),
    ];
    mount(firesAdapter(() => rows), { showMode: true });

    // The Mode column header proves the per-row mode chip is rendered.
    expect(await screen.findByRole("columnheader", { name: "Mode" })).toBeTruthy();
    // The legend renders both mode chips even when only one mode is present in rows.
    expect(screen.getAllByText("LIVE").length).toBeGreaterThan(0);
    expect(screen.getAllByText("TEST").length).toBeGreaterThan(0);
  });

  it("hides the Mode column and legend entirely when showMode is off", async () => {
    const rows = [makeFire({ id: "f0", mode: "live", requestKey: "rk0" })];
    mount(firesAdapter(() => rows), { showMode: false });

    // Wait for the row to load, then assert the mode surface is fully suppressed.
    expect(await screen.findByText("Fire history (1)")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Mode" })).toBeNull();
    expect(screen.queryByText("LIVE")).toBeNull();
  });
});

describe("<FireHistory> — result tooltip (REQ-D11)", () => {
  it("exposes the pretty-printed chainResponse as the result tooltip, else an em dash", async () => {
    const rows = [
      makeFire({
        id: "f0",
        status: "success",
        requestKey: "rk0",
        chainResponse: { status: "ok", data: [1, 2] },
      }),
      makeFire({ id: "f1", status: "failure", errorMessage: "boom" }),
    ];
    mount(firesAdapter(() => rows));

    const affordance = await screen.findByText("result");
    // The tooltip carries the pretty-printed chain response so a reader hovers to
    // inspect it — the JSON is 2-space indented, not a collapsed one-liner.
    expect(affordance.getAttribute("title")).toContain('"status": "ok"');
    // Exactly one fire has a chain response; the failed one shows no affordance.
    expect(screen.getAllByText("result")).toHaveLength(1);
  });
});

describe("<FireHistory> — definition drift (REQ-D07)", () => {
  it("flags an older fingerprint amber and stays quiet for the newest on the page", async () => {
    const rows = [
      makeFire({ id: "f0", requestKey: "rk0", definitionFingerprint: "abcd1234ef" }),
      makeFire({ id: "f1", requestKey: "rk1", definitionFingerprint: "zzzz9999qq" }),
      makeFire({ id: "f2", requestKey: "rk2", definitionFingerprint: null }),
    ];
    mount(firesAdapter(() => rows));

    // Drift ref is fires[0] on this page: f1 ran under an OLDER definition, so it
    // is flagged with the amber 8-char fingerprint prefix + a drift title.
    const drift = await screen.findByText("⚠ zzzz9999");
    expect(drift.getAttribute("title")).toContain("zzzz9999qq");
    // The newest-on-page fire is quiet, and the fingerprint-less fire shows a dash.
    expect(screen.getByText("·")).toBeTruthy();
  });
});

describe("<FireHistory> — explorer deep link (REQ-D10)", () => {
  it("links a successful fire with a request key to the explorer, dash otherwise", async () => {
    const rows = [
      makeFire({ id: "f0", status: "success", requestKey: "rk_success_key" }),
      makeFire({ id: "f1", status: "failure", errorMessage: "nope" }),
    ];
    mount(firesAdapter(() => rows));

    const link = await screen.findByRole("link", { name: /explorer/ });
    // The deep link is explorerBase + '/' + the encoded key — exactly one success
    // fire qualifies, so exactly one explorer link exists.
    expect(link.getAttribute("href")).toBe(
      "https://explorer.stoachain.com/transactions/rk_success_key",
    );
    expect(screen.getAllByRole("link", { name: /explorer/ })).toHaveLength(1);
  });
});

describe("<FireHistory> — recover affordance (REQ-G09)", () => {
  it("recovers a failed fire for an admin: prompts, calls recover, refetches to success", async () => {
    const rows = [makeFire({ id: "f1", status: "failure", errorMessage: "gas under-funded" })];
    const key = "A".repeat(43);
    const adapter = firesAdapter(
      () => rows,
      (fireId) => {
        if (fireId === "f1") rows[0] = makeFire({ id: "f1", status: "success", requestKey: key });
      },
    );
    mount(adapter, { access: ADMIN, promptRequestKey: () => key });

    fireEvent.click(await screen.findByRole("button", { name: "recover" }));

    // Recover is gated: the request key + the fresh-confirm opt reach the adapter.
    expect(await screen.findByText("success")).toBeTruthy();
    expect((adapter.recover as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      "c1",
      "f1",
      key,
      { confirmed: true },
    );
  });

  it("does not offer recover to a non-admin (logged-out) viewer", async () => {
    const rows = [makeFire({ id: "f1", status: "failure", errorMessage: "boom" })];
    mount(firesAdapter(() => rows), { access: PUBLIC });

    expect(await screen.findByText("Fire history (1)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "recover" })).toBeNull();
  });
});

describe("<FireHistory> — 50/page pager (REQ-D09)", () => {
  it("shows the per-page summary at the default page size of 50", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => makeFire({ id: `f${i}`, requestKey: `rk${i}` }));
    mount(firesAdapter(() => rows));

    expect(await screen.findByText("Showing 1–3 of 3 fires · 50 per page")).toBeTruthy();
  });

  it("pages forward with setPage when there is more than one page", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      makeFire({ id: `f${i}`, status: "success", requestKey: `rk${i}` }),
    );
    mount(firesAdapter(() => rows), { pageSize: 2 });

    // Page 0 windows the first two rows; rk2 lives on page 1.
    expect(await screen.findByText("Showing 1–2 of 3 fires · 2 per page")).toBeTruthy();
    expect(screen.queryByText("rk2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next ›" }));

    // Next advances the offset to page 1 (offset 2), surfacing the tail row.
    expect(await screen.findByText("Showing 3–3 of 3 fires · 2 per page")).toBeTruthy();
    expect(screen.getByText("rk2")).toBeTruthy();
  });
});
