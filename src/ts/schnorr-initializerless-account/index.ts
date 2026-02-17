/**
 * SchnorrInitializerlessAccount - Library module
 *
 * Provides everything needed to work with SchnorrInitializerlessAccount contracts:
 * - Initializerless account contract using the #[immutables] macro
 * - AccountContract implementation for wallet integration
 * - AuthWitnessProvider for transaction signing
 * - Typed wrappers over generic initializerless immutables utilities
 *
 * ## Key Differences from Standard SchnorrAccountContract:
 *
 * | Feature | Standard | Initializerless Pattern |
 * |---------|----------|-------------------|
 * | Initializer | constructor() stores key | None |
 * | Key Storage | SinglePrivateImmutable | Capsule storage |
 * | Salt | Random | hash([actual_salt, public_key.x, public_key.y]) |
 * | Deployment | AccountManager.getDeployMethod() | Custom publishInstance() |
 *
 * ## How Salt Verification Works
 *
 * 1. TypeScript generates a random `actual_salt`
 * 2. Computes `salt = poseidon2_hash([actual_salt, public_key.x, public_key.y])`
 * 3. Creates contract instance with this `salt`
 * 4. Capsule stores `[actual_salt, public_key.x, public_key.y]`
 * 5. At runtime, Noir hashes capsule data and verifies against `instance.salt`
 */

import {
  type Account,
  type AccountContract,
  type AuthWitnessProvider,
  BaseAccount,
} from "@aztec/aztec.js/account";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type { CompleteAddress } from "@aztec/stdlib/contract";
import { DefaultAccountEntrypoint } from "@aztec/entrypoints/account";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { AuthWitness } from "@aztec/stdlib/auth-witness";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Capsule } from "@aztec/stdlib/tx";

import { SchnorrInitializerlessAccountContractArtifact } from "../../artifacts/SchnorrInitializerlessAccount.js";
import * as generic from "../immutables/utils.js";
import type { ImmutablesInstanceOptions } from "../immutables/utils.js";

// Re-export IMMUTABLES_SLOT from generic
export { IMMUTABLES_SLOT } from "../immutables/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Signing public key type (Grumpkin curve point coordinates)
 */
export interface SigningPublicKey {
  x: Fr;
  y: Fr;
}

/**
 * Result of computing a contract address
 */
export interface ComputeSchnorrAccountAddressResult {
  address: AztecAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serializes the signing public key to Fr array (matches Noir serialization)
 */
export function serializeSigningKey(key: SigningPublicKey): Fr[] {
  return [key.x, key.y];
}

// ---------------------------------------------------------------------------
// Typed wrappers over generic initializerless utilities
// ---------------------------------------------------------------------------

/**
 * Computes the contract salt from actual_salt and signing public key.
 * This must match the Noir: poseidon2_hash([actual_salt, public_key.x, public_key.y])
 *
 * @param actualSalt - The random salt value stored in the capsule
 * @param key - The signing public key
 * @returns The derived salt to use in the contract instance
 */
export function computeContractSalt(actualSalt: Fr, key: SigningPublicKey): Fr {
  return generic.computeContractSalt(actualSalt, serializeSigningKey(key));
}

/**
 * Creates a Capsule containing the actual_salt and signing key for a given contract address.
 * This capsule must be passed with any call that reads the signing key.
 *
 * Capsule format: [actual_salt, public_key.x, public_key.y]
 *
 * @param contractAddress - The contract address to create the capsule for
 * @param actualSalt - The random salt value used during deployment
 * @param key - The signing public key
 */
export function createSigningKeyCapsule(
  contractAddress: AztecAddress,
  actualSalt: Fr,
  key: SigningPublicKey,
): Capsule {
  return generic.createImmutablesCapsule(
    contractAddress,
    actualSalt,
    serializeSigningKey(key),
  );
}

/**
 * Computes the contract address for a given signing key without deploying.
 *
 * Useful for pre-computing addresses before deployment.
 *
 * @param signingKey - The signing public key
 * @param options - Optional address computation options
 * @returns The contract address and actual_salt for capsule creation
 */
export async function computeSchnorrAccountAddress(
  signingKey: SigningPublicKey,
  options?: ImmutablesInstanceOptions,
): Promise<ComputeSchnorrAccountAddressResult> {
  return generic.computeImmutablesAddress(
    SchnorrInitializerlessAccountContractArtifact,
    serializeSigningKey(signingKey),
    options,
  );
}

// ---------------------------------------------------------------------------
// AccountContract implementation
// ---------------------------------------------------------------------------

/**
 * AccountContract implementation for SchnorrInitializerlessAccount.
 *
 * This class enables the initializerless immutables account to work with
 * the Aztec wallet system for transaction signing.
 */
export class SchnorrInitializerlessAccountContract implements AccountContract {
  constructor(
    private signingPrivateKey: GrumpkinScalar,
    private signingPublicKey: SigningPublicKey,
  ) {}

  /**
   * Returns undefined since SchnorrInitializerlessAccount has no initializer.
   *
   * The contract's salt is computed from the signing key and passed
   * to the contract instance creation. initializationHash is set to zero.
   */
  async getInitializationFunctionAndArgs(): Promise<undefined> {
    return undefined;
  }

  /**
   * Returns the SchnorrInitializerlessAccount contract artifact.
   */
  async getContractArtifact(): Promise<ContractArtifact> {
    return SchnorrInitializerlessAccountContractArtifact;
  }

  /**
   * Returns an AuthWitnessProvider that creates Schnorr signatures.
   *
   * The signing is identical to the standard SchnorrAccount - both use
   * Schnorr signatures. The difference is only in how the contract verifies
   * the signature (capsule vs SinglePrivateImmutable storage).
   */
  getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return new SchnorrInitializerlessAuthWitnessProvider(
      this.signingPrivateKey,
    );
  }

  /**
   * Returns the Account for this account contract.
   */
  getAccount(completeAddress: CompleteAddress): Account {
    const authWitnessProvider = this.getAuthWitnessProvider(completeAddress);
    return new BaseAccount(
      new DefaultAccountEntrypoint(
        completeAddress.address,
        authWitnessProvider,
      ),
      authWitnessProvider,
      completeAddress,
    );
  }

  /**
   * Returns the signing public key used by this account.
   */
  getSigningPublicKey(): SigningPublicKey {
    return this.signingPublicKey;
  }
}

// ---------------------------------------------------------------------------
// AuthWitnessProvider
// ---------------------------------------------------------------------------

/**
 * AuthWitnessProvider for SchnorrInitializerlessAccount.
 *
 * Creates Schnorr signatures for transaction authorization.
 * Identical to the standard SchnorrAuthWitnessProvider.
 */
export class SchnorrInitializerlessAuthWitnessProvider implements AuthWitnessProvider {
  constructor(private signingPrivateKey: GrumpkinScalar) {}

  async createAuthWit(messageHash: Fr): Promise<AuthWitness> {
    const schnorr = new Schnorr();
    const signature = await schnorr.constructSignature(
      messageHash.toBuffer(),
      this.signingPrivateKey,
    );
    return new AuthWitness(messageHash, [...signature.toBuffer()]);
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a SchnorrInitializerlessAccountContract from a secret key.
 *
 * This derives the signing key pair from the secret and creates
 * an account contract ready for deployment.
 *
 * @param secretKey - The secret key to derive signing keys from
 * @returns The account contract with derived signing keys
 */
export async function createSchnorrInitializerlessAccountContract(
  secretKey: Fr,
): Promise<{
  contract: SchnorrInitializerlessAccountContract;
  signingPrivateKey: GrumpkinScalar;
  signingPublicKey: SigningPublicKey;
}> {
  // Derive signing key from secret
  const signingPrivateKey = GrumpkinScalar.fromHighLow(Fr.ZERO, secretKey);
  const schnorr = new Schnorr();
  const signingKey = await schnorr.computePublicKey(signingPrivateKey);

  // Convert to Fr - signingKey.x/y may already be Fr or bigint depending on package version
  const signingPublicKey: SigningPublicKey = {
    x: new Fr(
      typeof signingKey.x === "bigint" ? signingKey.x : signingKey.x.toBigInt(),
    ),
    y: new Fr(
      typeof signingKey.y === "bigint" ? signingKey.y : signingKey.y.toBigInt(),
    ),
  };

  const contract = new SchnorrInitializerlessAccountContract(
    signingPrivateKey,
    signingPublicKey,
  );

  return { contract, signingPrivateKey, signingPublicKey };
}
