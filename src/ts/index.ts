/**
 * immutables-macro
 *
 * TypeScript utilities for the Aztec `#[immutables]` Noir macro pattern.
 *
 * Two modules are exported:
 *
 * - `immutables` — Generic, contract-agnostic utilities for deploying any contract
 *   that uses the `#[immutables]` macro (salt derivation, capsule management,
 *   artifact introspection, deployment).
 *
 * - `schnorrAccount` — A production-ready Schnorr account contract implementation
 *   using the initializerless immutables pattern (AccountContract, AuthWitnessProvider,
 *   deployment, key serialization).
 */

export * as immutables from "./immutables/index.js";
export * as schnorrAccount from "./schnorr-initializerless-account/index.js";
