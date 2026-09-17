import { describe, it, expect } from "vitest";
import { formatThousands, postponedMessage } from "./format.js";

describe("formatThousands", () => {
  it("groups thousands with commas, locale-pinned to en-US regardless of host locale", () => {
    expect(formatThousands(42000)).toBe("42,000");
    expect(formatThousands(1500)).toBe("1,500");
    expect(formatThousands(15000000)).toBe("15,000,000");
  });

  it("leaves sub-thousand values unformatted", () => {
    expect(formatThousands(0)).toBe("0");
    expect(formatThousands(999)).toBe("999");
  });
});

describe("postponedMessage", () => {
  it("omits the detail clause entirely when plannedCount is absent", () => {
    expect(postponedMessage(undefined)).toBe("Simulation postponed.");
  });

  it("uses the SINGULAR 'transaction' for a planned count of exactly 1", () => {
    expect(postponedMessage(1)).toBe("Simulation postponed — 1 planned transaction.");
  });

  it("uses the PLURAL 'transactions' for any planned count other than 1", () => {
    expect(postponedMessage(0)).toBe("Simulation postponed — 0 planned transactions.");
    expect(postponedMessage(3)).toBe("Simulation postponed — 3 planned transactions.");
  });
});
