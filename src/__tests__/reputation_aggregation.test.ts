import { describe, it, expect } from "vitest";
import {
  AGGREGATION_CIRCUIT_V1,
  BN254_FIELD_MODULUS,
  isWellFormedProof,
  isWellFormedVerifyingKey,
  parseAggregationPublicSignals,
  unparseAggregationPublicSignals,
  type AggregationPublicSignals,
} from "../lib/zk/reputation_aggregation.js";

/**
 * Type wrapper for the ReputationAggregationProof artifacts (T1.1).
 *
 * The heavy crypto lives in `circuits/test/reputation_aggregation.test.mjs` (snarkjs end-to-end)
 * and in the Soroban verifier — both verify the actual Groth16 pairing. These tests cover the
 * lightweight surface: signal parsing, shape validation, and the locked v1 circuit constants
 * that downstream consumers (Soroban contract, demo scripts) rely on.
 */
describe("ReputationAggregationProof TS wrapper (T1.1)", () => {
  describe("AGGREGATION_CIRCUIT_V1 constants", () => {
    it("locks N=4 (4 categories per proof) — Soroban consumer indexes against this", () => {
      expect(AGGREGATION_CIRCUIT_V1.N).toBe(4);
    });
    it("locks tree depth = 8 (≤ 256 leaves per epoch root)", () => {
      expect(AGGREGATION_CIRCUIT_V1.TREE_DEPTH).toBe(8);
    });
    it("locks POT_POWER = 16 (matches the test pipeline + ceremony reproducibility)", () => {
      expect(AGGREGATION_CIRCUIT_V1.POT_POWER).toBe(16);
    });
    it("locks PUBLIC_INPUT_COUNT = 5 — matches the circuit's `public [...]` shape", () => {
      expect(AGGREGATION_CIRCUIT_V1.PUBLIC_INPUT_COUNT).toBe(5);
    });
    it("BN254_FIELD_MODULUS is the canonical bn128 scalar field modulus", () => {
      expect(BN254_FIELD_MODULUS).toBe(
        21888242871839275222246405745257275088548364400416034343698204186575808495617n,
      );
    });
  });

  describe("parseAggregationPublicSignals", () => {
    const happy: AggregationPublicSignals = {
      minTotal: 1500n,
      minDistinctCategories: 4n,
      minJobs: 20n,
      nullifier: "12345678901234567890",
      epochRoot: "98765432109876543210",
    };

    it("parses a well-formed 5-element decimal-string vector into the typed view", () => {
      const raw = ["1500", "4", "20", "12345678901234567890", "98765432109876543210"];
      expect(parseAggregationPublicSignals(raw)).toEqual(happy);
    });

    it("rejects the wrong number of signals (circuit guarantees exactly 5)", () => {
      expect(() => parseAggregationPublicSignals(["1", "2", "3"])).toThrow(/expected 5 public/);
      expect(() => parseAggregationPublicSignals(["1", "2", "3", "4", "5", "6"])).toThrow(/expected 5 public/);
    });

    it("rejects a non-decimal signal (snarkjs emits decimal-string field elements)", () => {
      expect(() => parseAggregationPublicSignals(["1500", "4", "20", "0xdead", "1"])).toThrow(/not a decimal/);
      expect(() => parseAggregationPublicSignals(["1500", "four", "20", "1", "1"])).toThrow(/not a decimal/);
    });

    it("round-trips through unparse → parse without drift", () => {
      const raw = unparseAggregationPublicSignals(happy);
      expect(raw).toHaveLength(AGGREGATION_CIRCUIT_V1.PUBLIC_INPUT_COUNT);
      expect(parseAggregationPublicSignals(raw)).toEqual(happy);
    });

    it("preserves bigint values past Number.MAX_SAFE_INTEGER (field elements are 254 bits)", () => {
      const huge = (BN254_FIELD_MODULUS - 1n).toString();
      const raw = ["1500", "4", "20", huge, "1"];
      const parsed = parseAggregationPublicSignals(raw);
      expect(parsed.nullifier).toBe(huge);                  // string preserved exactly
      expect(parsed.nullifier.length).toBeGreaterThan(60);  // way past JS-number range
    });
  });

  describe("isWellFormedProof", () => {
    const validProof = {
      protocol: "groth16",
      curve: "bn128",
      pi_a: ["1", "2", "1"],
      pi_b: [["1", "2"], ["3", "4"], ["1", "0"]],
      pi_c: ["5", "6", "1"],
    };

    it("accepts the canonical snarkjs Groth16 JSON shape", () => {
      expect(isWellFormedProof(validProof)).toBe(true);
    });

    it("rejects a proof with wrong protocol or curve", () => {
      expect(isWellFormedProof({ ...validProof, protocol: "plonk" })).toBe(false);
      expect(isWellFormedProof({ ...validProof, curve: "bls12-381" })).toBe(false);
    });

    it("rejects a proof with missing or wrong-length tuple fields", () => {
      expect(isWellFormedProof({ ...validProof, pi_a: ["1", "2"] })).toBe(false);
      expect(isWellFormedProof({ ...validProof, pi_b: undefined })).toBe(false);
      expect(isWellFormedProof({ ...validProof, pi_c: ["1"] })).toBe(false);
    });

    it("rejects non-object inputs", () => {
      expect(isWellFormedProof(null)).toBe(false);
      expect(isWellFormedProof("0xabc")).toBe(false);
      expect(isWellFormedProof(42)).toBe(false);
    });
  });

  describe("isWellFormedVerifyingKey", () => {
    const validVK = {
      protocol: "groth16",
      curve: "bn128",
      nPublic: 5,
      IC: [["1", "2", "1"]],
    };

    it("accepts a well-formed Groth16 vkey", () => {
      expect(isWellFormedVerifyingKey(validVK)).toBe(true);
    });

    it("rejects vkey with wrong protocol / curve / missing IC", () => {
      expect(isWellFormedVerifyingKey({ ...validVK, protocol: "plonk" })).toBe(false);
      expect(isWellFormedVerifyingKey({ ...validVK, curve: "bls12-381" })).toBe(false);
      expect(isWellFormedVerifyingKey({ ...validVK, IC: undefined })).toBe(false);
      expect(isWellFormedVerifyingKey({ ...validVK, nPublic: "5" })).toBe(false);
    });
  });
});
