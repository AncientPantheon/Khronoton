import { describe, it, expect } from "vitest";
import type { CodexCronotonRow } from "../server/index.js";
import {
  makeEmptyBuilderState,
  builderToCommit,
  detailToBuilderState,
  validateName,
  validateConfig,
  validateGasPayer,
  validatePayload,
  validateSigners,
  canCommit,
  isTriggerOnly,
  parseRuntimeArgKeysText,
  maxTxFee,
  effectiveSignerCount,
  type BuilderState,
} from "./builder-state.js";

/** A fully-committable state: named, gas-station with a signing key (one signer). */
function committableState(): BuilderState {
  const s = makeEmptyBuilderState();
  s.name = "Daily payout";
  s.gasPayer = { type: "gas-station", signingKey: "b".repeat(64) };
  return s;
}

/** A representative persisted row for rehydration tests. */
function sampleRow(overrides: Partial<CodexCronotonRow> = {}): CodexCronotonRow {
  return {
    id: "cx1",
    name: "Daily payout",
    description: "pays daily",
    pact_code: "(coin.transfer)",
    config_json: JSON.stringify({
      chainId: "2",
      gasPrice: 20000,
      gasLimit: 2500,
      autoGasLimit: true,
      ttl: 1200,
    }),
    payload_json: JSON.stringify({
      amount: 1.5,
      ks: { keys: ["a".repeat(64)], pred: "keys-all" },
    }),
    gas_payer_json: JSON.stringify({
      type: "gas-station",
      gasStationSignerKey: "b".repeat(64),
    }),
    signers_json: JSON.stringify([
      { publicKey: "c".repeat(64), capabilityMode: "scoped", capabilities: "(coin.GAS)" },
    ]),
    schedule_mode: "weekly",
    schedule_config_json: JSON.stringify({
      mode: "weekly",
      daysOfWeek: [1, 3],
      hour: 9,
      minute: 30,
    }),
    server_resolver: "stoicism-mint",
    external_fireable: 1,
    runtime_arg_keys: JSON.stringify(["amount"]),
    status: "active",
    next_fire_at: null,
    last_fire_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
    created_by: "admin@x",
    ...overrides,
  };
}

describe("makeEmptyBuilderState defaults", () => {
  it("seeds the exact builder-spec defaults so a fresh form matches the Hub", () => {
    const s = makeEmptyBuilderState();
    expect(s.name).toBe("");
    expect(s.description).toBe("");
    expect(s.pactCode).toBe("");
    expect(s.config).toEqual({
      chainId: "0",
      gasPriceAnu: 10000,
      gasLimit: 1500,
      autoGasLimit: false,
      ttl: 600,
    });
    expect(s.payload).toEqual({
      entries: [],
      keysets: [],
      rawMode: false,
      rawJson: "{}",
    });
    expect(s.gasPayer).toEqual({ type: "gas-station" });
    expect(s.signers).toEqual([]);
    expect(s.schedule).toEqual({
      mode: "daily-at-utc",
      config: { mode: "daily-at-utc", hours: [12], minute: 0 },
    });
    expect(s.serverResolver).toBeUndefined();
    expect(s.externalFireable).toBe(false);
    expect(s.runtimeArgKeysText).toBe("");
  });

  it("returns an independent object each call (no shared mutable defaults)", () => {
    const a = makeEmptyBuilderState();
    a.config.gasLimit = 9999;
    a.signers.push({
      id: "x",
      publicKey: "p",
      label: "",
      source: "foreign",
      capabilityMode: "pure",
      capabilities: "",
    });
    const b = makeEmptyBuilderState();
    expect(b.config.gasLimit).toBe(1500);
    expect(b.signers).toEqual([]);
  });
});

describe("maxTxFee", () => {
  it("derives gas price x gas limit so the read-only fee display stays authoritative", () => {
    expect(maxTxFee(makeEmptyBuilderState().config)).toBe(15_000_000);
    expect(maxTxFee({ ...makeEmptyBuilderState().config, gasLimit: 2500, gasPriceAnu: 20000 })).toBe(
      50_000_000,
    );
  });
});

describe("builderToCommit — envelope config + gas payer", () => {
  it("maps gasPriceAnu back to the store's gasPrice field losslessly", () => {
    const s = committableState();
    s.config = { chainId: "5", gasPriceAnu: 12345, gasLimit: 2000, autoGasLimit: true, ttl: 900 };
    const { config } = builderToCommit(s).envelope;
    expect(config).toEqual({
      chainId: "5",
      gasPrice: 12345,
      gasLimit: 2000,
      autoGasLimit: true,
      ttl: 900,
    });
  });

  it("serializes a gas-station payer with its DALOS.GAS_PAYER signing key", () => {
    const s = committableState();
    s.gasPayer = { type: "gas-station", signingKey: "GS" };
    expect(builderToCommit(s).envelope.gasPayer).toEqual({
      type: "gas-station",
      gasStationSignerKey: "GS",
    });
  });

  it("serializes a codex payer with its address", () => {
    const s = committableState();
    s.gasPayer = { type: "codex", address: "k:abc" };
    expect(builderToCommit(s).envelope.gasPayer).toEqual({ type: "codex", address: "k:abc" });
  });

  it("carries name and top-level fields into the CommitBody shape", () => {
    const s = committableState();
    s.name = "Nightly";
    s.description = "runs nightly";
    s.pactCode = "(do-thing)";
    const body = builderToCommit(s);
    expect(body.name).toBe("Nightly");
    expect(body.description).toBe("runs nightly");
    expect(body.envelope.pactCode).toBe("(do-thing)");
  });
});

describe("builderToCommit — payload (typed vs raw)", () => {
  it("flattens typed entries by their declared type + keysets into an env-data object", () => {
    const s = committableState();
    s.payload.entries = [
      { key: "amount", type: "number", value: "1.5" },
      { key: "active", type: "boolean", value: "true" },
      { key: "label", type: "string", value: "hello" },
      { key: "meta", type: "json", value: '{"a":1}' },
    ];
    s.payload.keysets = [{ name: "ks", predicate: "keys-all", keysText: "aaaa\nbbbb" }];
    expect(builderToCommit(s).envelope.payload).toEqual({
      amount: 1.5,
      active: true,
      label: "hello",
      meta: { a: 1 },
      ks: { keys: ["aaaa", "bbbb"], pred: "keys-all" },
    });
  });

  it("uses the raw JSON object verbatim when rawMode is on", () => {
    const s = committableState();
    s.payload.rawMode = true;
    s.payload.rawJson = '{"amount": 2.0, "who": "x"}';
    expect(builderToCommit(s).envelope.payload).toEqual({ amount: 2, who: "x" });
  });
});

describe("builderToCommit — signers", () => {
  it("emits manual signers with pure signers stripped of capabilities", () => {
    const s = committableState();
    s.signers = [
      { id: "1", publicKey: "PK1", label: "", source: "derived", capabilityMode: "pure", capabilities: "(coin.GAS)" },
      { id: "2", publicKey: "PK2", label: "", source: "foreign", capabilityMode: "scoped", capabilities: "(coin.GAS)" },
    ];
    expect(builderToCommit(s).envelope.signers).toEqual([
      { publicKey: "PK1", capabilityMode: "pure", capabilities: "" },
      { publicKey: "PK2", capabilityMode: "scoped", capabilities: "(coin.GAS)" },
    ]);
  });
});

describe("builderToCommit — schedule + trigger-only + resolver", () => {
  it("passes the schedule mode + config through unchanged", () => {
    const s = committableState();
    s.schedule = { mode: "cron-expression", config: { mode: "cron-expression", expression: "0 12 * * 1-5" } };
    expect(builderToCommit(s).schedule).toEqual({
      mode: "cron-expression",
      config: { mode: "cron-expression", expression: "0 12 * * 1-5" },
    });
  });

  it("includes runtimeArgKeys + externalFireable only for the trigger-only case", () => {
    const s = committableState();
    s.runtimeArgKeysText = "amount, recipient\nnote";
    s.externalFireable = true;
    const env = builderToCommit(s).envelope;
    expect(env.runtimeArgKeys).toEqual(["amount", "recipient", "note"]);
    expect(env.externalFireable).toBe(true);
  });

  it("omits runtimeArgKeys + externalFireable for an ordinary fixed cronoton", () => {
    const env = builderToCommit(committableState()).envelope;
    expect(env.runtimeArgKeys).toBeUndefined();
    expect(env.externalFireable).toBeUndefined();
  });

  it("carries serverResolver when set and omits it otherwise", () => {
    const s = committableState();
    s.serverResolver = "stoicism-mint";
    expect(builderToCommit(s).envelope.serverResolver).toBe("stoicism-mint");
    expect(builderToCommit(committableState()).envelope.serverResolver).toBeUndefined();
  });
});

describe("parseRuntimeArgKeysText / isTriggerOnly", () => {
  it("splits comma-or-newline separated keys and drops blanks", () => {
    expect(parseRuntimeArgKeysText("amount, recipient\n\n note ")).toEqual([
      "amount",
      "recipient",
      "note",
    ]);
    expect(parseRuntimeArgKeysText("")).toEqual([]);
  });

  it("treats any declared runtime-arg key as trigger-only", () => {
    const s = makeEmptyBuilderState();
    expect(isTriggerOnly(s)).toBe(false);
    s.runtimeArgKeysText = "amount";
    expect(isTriggerOnly(s)).toBe(true);
  });
});

describe("validateName", () => {
  it("blocks an empty name with the verbatim message", () => {
    expect(validateName(makeEmptyBuilderState())).toEqual(["Name is required."]);
  });
  it("passes a whitespace-trimmed non-empty name", () => {
    const s = makeEmptyBuilderState();
    s.name = "  Job ";
    expect(validateName(s)).toEqual([]);
  });
});

describe("validateConfig", () => {
  it("rejects a ttl outside 60..86400 with the verbatim message", () => {
    const lo = makeEmptyBuilderState();
    lo.config.ttl = 59;
    expect(validateConfig(lo)).toContain("TTL must be between 60 and 86400 seconds.");
    const hi = makeEmptyBuilderState();
    hi.config.ttl = 86401;
    expect(validateConfig(hi)).toContain("TTL must be between 60 and 86400 seconds.");
  });

  it("rejects a gas price below the 10000 ANU protocol floor", () => {
    const s = makeEmptyBuilderState();
    s.config.gasPriceAnu = 9999;
    expect(validateConfig(s)).toContain(
      "Gas price must be at least 10000 ANU (the protocol floor).",
    );
  });

  it("rejects a non-positive gas limit", () => {
    const s = makeEmptyBuilderState();
    s.config.gasLimit = 0;
    expect(validateConfig(s)).toContain("Gas limit must be greater than zero.");
  });

  it("requires a successful Simulate when AUTO gas is on and not calibrated", () => {
    const s = makeEmptyBuilderState();
    s.config.autoGasLimit = true;
    expect(validateConfig(s)).toContain(
      "AUTO gas requires a successful Simulate to calibrate, or switch to manual.",
    );
    expect(validateConfig(s, { simulateCalibrated: true })).not.toContain(
      "AUTO gas requires a successful Simulate to calibrate, or switch to manual.",
    );
  });

  it("waives the AUTO-gas calibration requirement for a server-resolver cronoton", () => {
    const s = makeEmptyBuilderState();
    s.config.autoGasLimit = true;
    s.serverResolver = "stoicism-mint";
    expect(validateConfig(s)).not.toContain(
      "AUTO gas requires a successful Simulate to calibrate, or switch to manual.",
    );
  });

  it("waives the AUTO-gas calibration requirement for a trigger-only cronoton", () => {
    const s = makeEmptyBuilderState();
    s.config.autoGasLimit = true;
    s.runtimeArgKeysText = "amount";
    expect(validateConfig(s)).not.toContain(
      "AUTO gas requires a successful Simulate to calibrate, or switch to manual.",
    );
  });

  it("passes the default manual config", () => {
    expect(validateConfig(makeEmptyBuilderState())).toEqual([]);
  });
});

describe("validateGasPayer", () => {
  it("demands a signing key for the default gas station", () => {
    expect(validateGasPayer(makeEmptyBuilderState())).toEqual([
      "Select a key to sign the DALOS.GAS_PAYER capability.",
    ]);
  });
  it("demands an address for a codex payer", () => {
    const s = makeEmptyBuilderState();
    s.gasPayer = { type: "codex" };
    expect(validateGasPayer(s)).toEqual(["Select a codex account to pay gas."]);
  });
  it("passes a configured gas station and a configured codex payer", () => {
    const gs = makeEmptyBuilderState();
    gs.gasPayer = { type: "gas-station", signingKey: "k" };
    expect(validateGasPayer(gs)).toEqual([]);
    const cx = makeEmptyBuilderState();
    cx.gasPayer = { type: "codex", address: "k:abc" };
    expect(validateGasPayer(cx)).toEqual([]);
  });
});

describe("validatePayload", () => {
  it("blocks a raw payload that is not a JSON object", () => {
    const s = makeEmptyBuilderState();
    s.payload.rawMode = true;
    s.payload.rawJson = "[1,2,3]";
    expect(validatePayload(s).errors).toContain("Raw payload must be a JSON object.");
    const bad = makeEmptyBuilderState();
    bad.payload.rawMode = true;
    bad.payload.rawJson = "{ not json";
    expect(validatePayload(bad).errors).toContain("Raw payload must be a JSON object.");
  });

  it("blocks a keyset missing its name, keys, or predicate", () => {
    const noName = makeEmptyBuilderState();
    noName.payload.keysets = [{ name: "", predicate: "keys-all", keysText: "aaaa" }];
    expect(validatePayload(noName).errors).toContain("Each keyset needs a name.");

    const noKeys = makeEmptyBuilderState();
    noKeys.payload.keysets = [{ name: "ks", predicate: "keys-all", keysText: "   " }];
    expect(validatePayload(noKeys).errors).toContain('Keyset "ks" needs at least one key.');

    const noPred = makeEmptyBuilderState();
    noPred.payload.keysets = [
      { name: "ks", predicate: "" as unknown as "keys-all", keysText: "aaaa" },
    ];
    expect(validatePayload(noPred).errors).toContain('Keyset "ks" needs a predicate.');
  });

  it("warns (non-blocking) when Pact code references a keyset absent from the payload", () => {
    const s = makeEmptyBuilderState();
    s.pactCode = '(enforce-keyset (read-keyset "admin-ks"))';
    const res = validatePayload(s);
    expect(res.warnings).toContain(
      'Pact code references keyset "admin-ks" which is not defined in the payload.',
    );
    expect(res.errors).toEqual([]);
  });

  it("does not warn once the referenced keyset is defined in the payload", () => {
    const s = makeEmptyBuilderState();
    s.pactCode = '(enforce-keyset (read-keyset "admin-ks"))';
    s.payload.keysets = [{ name: "admin-ks", predicate: "keys-all", keysText: "aaaa" }];
    expect(validatePayload(s).warnings).toEqual([]);
  });
});

describe("validateSigners / effectiveSignerCount", () => {
  it("counts the auto gas-payer signer toward the at-least-one requirement", () => {
    const fresh = makeEmptyBuilderState();
    expect(effectiveSignerCount(fresh)).toBe(0);
    expect(validateSigners(fresh)).toEqual(["At least one signer is required."]);

    const withGasKey = makeEmptyBuilderState();
    withGasKey.gasPayer = { type: "gas-station", signingKey: "k" };
    expect(effectiveSignerCount(withGasKey)).toBe(1);
    expect(validateSigners(withGasKey)).toEqual([]);
  });

  it("counts a manual signer even when the gas payer is unconfigured", () => {
    const s = makeEmptyBuilderState();
    s.signers = [
      { id: "1", publicKey: "PK", label: "", source: "foreign", capabilityMode: "pure", capabilities: "" },
    ];
    expect(effectiveSignerCount(s)).toBe(1);
    expect(validateSigners(s)).toEqual([]);
  });
});

describe("canCommit", () => {
  it("blocks the fresh default with name → gas-payer → signer reasons in order", () => {
    const res = canCommit(makeEmptyBuilderState());
    expect(res.ok).toBe(false);
    expect(res.reasons).toEqual([
      "Name is required.",
      "Select a key to sign the DALOS.GAS_PAYER capability.",
      "At least one signer is required.",
    ]);
  });

  it("folds reasons in the fixed order name → config → gasPayer → payload → signers", () => {
    const s = makeEmptyBuilderState();
    s.config.ttl = 10; // config reason
    s.payload.rawMode = true;
    s.payload.rawJson = "[]"; // payload reason
    const reasons = canCommit(s).reasons;
    expect(reasons.indexOf("Name is required.")).toBeLessThan(
      reasons.indexOf("TTL must be between 60 and 86400 seconds."),
    );
    expect(reasons.indexOf("TTL must be between 60 and 86400 seconds.")).toBeLessThan(
      reasons.indexOf("Select a key to sign the DALOS.GAS_PAYER capability."),
    );
    expect(reasons.indexOf("Select a key to sign the DALOS.GAS_PAYER capability.")).toBeLessThan(
      reasons.indexOf("Raw payload must be a JSON object."),
    );
    expect(reasons.indexOf("Raw payload must be a JSON object.")).toBeLessThan(
      reasons.indexOf("At least one signer is required."),
    );
  });

  it("passes a fully configured cronoton", () => {
    const res = canCommit(committableState());
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
  });

  it("forwards simulateCalibrated so an AUTO-gas job can commit after Simulate", () => {
    const s = committableState();
    s.config.autoGasLimit = true;
    expect(canCommit(s).ok).toBe(false);
    expect(canCommit(s, { simulateCalibrated: true }).ok).toBe(true);
  });

  it("does not list the non-blocking keyset warning as a commit reason", () => {
    const s = committableState();
    s.pactCode = '(read-keyset "ghost")';
    expect(canCommit(s).ok).toBe(true);
  });
});

describe("detailToBuilderState — edit rehydration", () => {
  it("forces raw payload mode with pretty JSON and empty typed rows", () => {
    const s = detailToBuilderState(sampleRow());
    expect(s.payload.rawMode).toBe(true);
    expect(s.payload.entries).toEqual([]);
    expect(s.payload.keysets).toEqual([]);
    expect(s.payload.rawJson).toContain("\n"); // pretty-printed
    expect(JSON.parse(s.payload.rawJson)).toEqual({
      amount: 1.5,
      ks: { keys: ["a".repeat(64)], pred: "keys-all" },
    });
  });

  it("maps stored gasPrice back to gasPriceAnu and preserves the rest of config", () => {
    const s = detailToBuilderState(sampleRow());
    expect(s.config).toEqual({
      chainId: "2",
      gasPriceAnu: 20000,
      gasLimit: 2500,
      autoGasLimit: true,
      ttl: 1200,
    });
  });

  it("preserves serverResolver and the gas-station payer with its signing key", () => {
    const s = detailToBuilderState(sampleRow());
    expect(s.serverResolver).toBe("stoicism-mint");
    expect(s.gasPayer).toEqual({ type: "gas-station", signingKey: "b".repeat(64) });
  });

  it("preserves a codex gas payer address", () => {
    const s = detailToBuilderState(
      sampleRow({
        gas_payer_json: JSON.stringify({ type: "codex", address: "k:abc" }),
      }),
    );
    expect(s.gasPayer).toEqual({ type: "codex", address: "k:abc" });
  });

  it("rehydrates signers lossily: fresh unique id, blank label, foreign source, caps kept", () => {
    const s = detailToBuilderState(
      sampleRow({
        signers_json: JSON.stringify([
          { publicKey: "P1", capabilityMode: "scoped", capabilities: "(coin.GAS)" },
          { publicKey: "P2", capabilityMode: "pure", capabilities: "" },
        ]),
      }),
    );
    expect(s.signers).toHaveLength(2);
    expect(s.signers.map((x) => x.id)).toEqual([...new Set(s.signers.map((x) => x.id))]);
    expect(s.signers.every((x) => x.id.length > 0)).toBe(true);
    expect(s.signers[0]).toMatchObject({
      publicKey: "P1",
      label: "",
      source: "foreign",
      capabilityMode: "scoped",
      capabilities: "(coin.GAS)",
    });
    expect(s.signers[1]).toMatchObject({
      publicKey: "P2",
      source: "foreign",
      capabilityMode: "pure",
    });
  });

  it("preserves the schedule mode + config", () => {
    const s = detailToBuilderState(sampleRow());
    expect(s.schedule).toEqual({
      mode: "weekly",
      config: { mode: "weekly", daysOfWeek: [1, 3], hour: 9, minute: 30 },
    });
  });

  it("drops the create-only externalFireable + runtime_arg_keys (absent in edit)", () => {
    const s = detailToBuilderState(sampleRow());
    expect(s.externalFireable).toBe(false);
    expect(s.runtimeArgKeysText).toBe("");
  });

  it("maps name, description, and pact code", () => {
    const s = detailToBuilderState(sampleRow());
    expect(s.name).toBe("Daily payout");
    expect(s.description).toBe("pays daily");
    expect(s.pactCode).toBe("(coin.transfer)");
  });

  it("round-trips definition fields back through builderToCommit (raw payload preserved)", () => {
    const env = builderToCommit(detailToBuilderState(sampleRow())).envelope;
    expect(env.config.gasPrice).toBe(20000);
    expect(env.payload).toEqual({
      amount: 1.5,
      ks: { keys: ["a".repeat(64)], pred: "keys-all" },
    });
    expect(env.serverResolver).toBe("stoicism-mint");
    // create-only fields are absent from the rehydrated edit body
    expect(env.runtimeArgKeys).toBeUndefined();
    expect(env.externalFireable).toBeUndefined();
  });

  it("tolerates a null payload/description by defaulting to an empty object/string", () => {
    const s = detailToBuilderState(
      sampleRow({ payload_json: null, description: null, server_resolver: null }),
    );
    expect(JSON.parse(s.payload.rawJson)).toEqual({});
    expect(s.description).toBe("");
    expect(s.serverResolver).toBeUndefined();
  });
});
