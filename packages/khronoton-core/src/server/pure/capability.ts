/**
 * Pure, side-effect-free executor helpers ported verbatim from the
 * AncientHoldings hub (lib/codex-cronoton/executor.ts:72-131). Kept dependency-
 * free so the terminal-intent mapping and the capability parser can be reused
 * and unit-pinned in isolation from the chain runtime seam.
 */
import type { ScheduleKind, ExecutorMode, TerminalIntent } from "../types.js";

/**
 * Parse a single capability line into a structured `{ name, args }`.
 *
 * Supported formats:
 *   - `(module.CAP arg1 "arg2" 0.5)` — parenthesized with optional args
 *   - `module.CAP`                    — bare dotted name, no args
 *
 * Returns null if the line cannot be parsed. Known F-006 limitation: a negative
 * numeric arg (`-1`) encodes as the STRING `'-1'` — the `/^\d+$/` int test
 * rejects the leading minus, so it falls through to the raw-token branch. This
 * behavior is preserved deliberately; do not "fix" it.
 */
export function parseCapabilityLine(
  line: string,
): { name: string; args: unknown[] } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(1, -1);
    const spaceIndex = inner.indexOf(" ");

    if (spaceIndex > -1) {
      const capName = inner.substring(0, spaceIndex);
      const argsString = inner.substring(spaceIndex + 1);

      const args: unknown[] = [];
      const argMatches = argsString.match(/("([^"\\]|\\.)*"|[^\s]+)/g) || [];

      for (const arg of argMatches) {
        if (arg.startsWith('"') && arg.endsWith('"')) {
          args.push(arg.slice(1, -1));
        } else if (/^\d+$/.test(arg)) {
          args.push({ int: parseInt(arg, 10) });
        } else if (/^\d*\.\d+$/.test(arg)) {
          args.push({ decimal: arg });
        } else {
          args.push(arg);
        }
      }

      return { name: capName, args };
    }
    return { name: inner, args: [] };
  }

  if (trimmed.includes(".")) {
    return { name: trimmed, args: [] };
  }

  return null;
}

/**
 * Pure, side-effect-free terminal-intent mapping.
 *
 * - one-time + fire + success → completed (single attempt spent)
 * - one-time + fire + ANY failure → error (single attempt spent — no retry)
 * - recurring, or any simulate → null
 */
export function computeTerminalIntent(
  scheduleKind: ScheduleKind | undefined,
  mode: ExecutorMode,
  ok: boolean,
): TerminalIntent | null {
  if (mode !== "fire") return null;
  if (scheduleKind !== "one-time") return null;
  return ok
    ? { status: "completed", clearNextFire: true }
    : { status: "error", clearNextFire: true };
}
