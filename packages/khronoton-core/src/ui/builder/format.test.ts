import { describe, it, expect } from "vitest";
import { formatThousands } from "./format.js";

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
