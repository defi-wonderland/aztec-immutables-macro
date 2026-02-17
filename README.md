# Immutables Macro

A Noir macro for committing immutables into an Aztec contract's address, eliminating the need for initializer functions.

## Overview

On Aztec, contracts that need immutable values — such as an account contract's signing public key — must currently use an initializer function that writes to private storage (e.g. `SinglePrivateImmutable`). This requires an initialization transaction, note delivery for setup, and initialization checks on subsequent function calls.

The `#[immutables]` macro offers a different approach: immutables are committed-to in the contract's `salt`, which is part of the address derivation. At runtime, immutables are loaded from capsule storage and verified against their commitment in the address.

This repo includes an **initializerless Schnorr account contract** as an example use case.

## How It Works

A contract's address is derived from public keys, contract class ID, salt, initialization hash, and deployer. The `salt` has no protocol-level constraints — it's a free field in the address commitment. We encode immutables into it:

```
salt = poseidon2_hash([actual_salt, constant_0, constant_1, ...])
```

Where `actual_salt` is a random nonce for address uniqueness.

**Deployment (TypeScript):**

1. Serialize the immutables into fields (e.g., a public key becomes `[x, y]`).
2. Generate a random `actual_salt`.
3. Compute `salt = poseidon2_hash([actual_salt, constant_0, constant_1, ...])`.
4. Store `[actual_salt, constant_0, constant_1, ...]` in PXE capsule storage at a well-known slot.
5. Deploy the contract with the derived salt — no initializer needed.

**Reconstruction and verification (Noir):**

1. Load capsule data from an unconstrained oracle.
2. Compute `salt = poseidon2_hash(capsule_data)`.
3. Fetch the contract instance via `get_contract_instance(address)`.
4. Assert that the computed salt matches `instance.salt`.
5. Deserialize and return the immutables.

Even though capsule data comes from an unconstrained oracle, security is guaranteed because `salt` is part of the contract address computation. If the wrong data is provided, `poseidon2_hash` won't match `instance.salt`.

## Usage

### 1. Add the dependency

In your contract's `Nargo.toml`:

```toml
[dependencies]
immutables = { git = "https://github.com/defi-wonderland/constants-macro", tag = "v4.0.0-devnet.1-patch.0" }
```

### 2. Define your immutables

```noir
use immutables::immutables;

#[derive(Deserialize)]
#[immutables]
pub struct Immutables {
    pub signing_public_key: PublicKey,
}
```

Requirements:
- The struct **must** be named `Immutables`
- `#[derive(Deserialize)]` is required
- Fields can be any type that implements `Serialize` and `Deserialize`

### 3. Use immutables in your contract

The macro generates `Immutables::init()` for constrained contexts and `Immutables::init_unconstrained()` for utility functions.

```rust
// In a #[external("private")] function
#[external("private")]
fn get_signing_public_key() -> pub (Field, Field) {
    let immutables = Immutables::init(self.context);
    let public_key = immutables.signing_public_key;
    (public_key.x, public_key.y)
}

// In a #[contract_library_method] function
#[contract_library_method]
fn is_valid_impl(context: &mut PrivateContext, outer_hash: Field) -> bool {
    let immutables = Immutables::init(context);
    let public_key = immutables.signing_public_key;
    // verify signature with public_key...
}

// In a utility (unconstrained) function
#[external("utility")]
unconstrained fn lookup_validity(consumer: AztecAddress, inner_hash: Field) -> bool {
    let immutables = Immutables::init_unconstrained(self.context);
    let public_key = immutables.signing_public_key;
    // ...
}
```

### 4. Attach capsules to transactions (TypeScript)

Every transaction that calls a function using `Immutables::init()` must include a capsule with the immutable data. Capsules are consumed per-call, so you must attach one to **every** transaction that reads immutables.

```typescript
import { Capsule } from "@aztec/stdlib/tx";
import { Fr } from "@aztec/aztec.js/fields";

/**
 * Constants slot - must match CONSTANTS_SLOT in the #[constants] Noir macro.
 * Computed as: poseidon2_hash_bytes("IMMUTABLES_SLOT".as_bytes())
 */
const IMMUTABLES_SLOT = new Fr(
  0x1a0e563e6a2087002308173ed42dec43b9543a3684de63d6be9a958c0eaf5c45
);

const capsule = new Capsule(contractAddress, IMMUTABLES_SLOT, [
  actualSalt,
  ...serializedImmutables,
]);

await contract.methods
  .my_function()
  .with({ capsules: [capsule] })
  .send({ from: caller });
```

### Compatibility with storage

The immutables pattern is compatible with `#[storage]`. Both can coexist in the same contract — immutables are verified against `salt`, while storage is managed via the state tree. See `src/nr/immutables_contract` for an example of mixed usage.

## Reference Implementation: Initializerless Schnorr Account

The `schnorr_initializerless_account_contract` demonstrates the pattern applied to an account contract. It replaces `SinglePrivateImmutable<PublicKeyNote>` + initializer with an `Immutables` struct:

```rust
use immutables::immutables;

#[derive(Deserialize)]
#[immutables]
pub struct Immutables {
    pub public_key: PublicKey,
}

#[contract_library_method]
fn is_valid_impl(context: &mut PrivateContext, outer_hash: Field) -> bool {
    let immutables = Immutables::init(context);
    let public_key = immutables.public_key;
    // verify Schnorr signature...
}
```

No constructor, no note delivery, no `#[noinitcheck]`. The contract is immediately usable after deployment.

A standard `schnorr_account_contract` using the traditional initializer pattern is included for comparison.

## Project Structure

```
src/nr/
├── immutables/               # The #[immutables] macro library
│   └── src/macro.nr
├── schnorr_initializerless_account_contract/  # Initializerless Schnorr account
│   └── src/
│       ├── main.nr
│       └── public_key.nr
├── schnorr_account_contract/                  # Standard Schnorr account (for comparison)
│   └── src/
│       ├── main.nr
│       └── public_key_note.nr
└── immutables_contract/                       # Example: immutables + storage coexistence
    └── src/main.nr
```

## Development

### Prerequisites

- [Aztec CLI](https://docs.aztec.network/)
- [Noir](https://noir-lang.org/) (`>=1.0.0`)
- Node.js (`>=22.0.0`)
- Yarn (`>=1.22.0`)

### Setup

```bash
yarn install
```

### Build

```bash
# Clean, compile Noir contracts, and generate TypeScript artifacts
yarn ccc
```

### Test

```bash
# Run all tests (Noir + TypeScript)
yarn test

# Run Noir tests only
yarn test:nr

# Run TypeScript tests only
yarn test:js
```

### Benchmark

```bash
yarn benchmark
```

## License

MIT
