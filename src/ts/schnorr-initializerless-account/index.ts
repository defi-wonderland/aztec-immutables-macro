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
  AccountWithSecretKey,
  BaseAccount,
} from "@aztec/aztec.js/account";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import { CompleteAddress } from "@aztec/stdlib/contract";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import { DefaultAccountEntrypoint } from "@aztec/entrypoints/account";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { AuthWitness } from "@aztec/stdlib/auth-witness";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Capsule } from "@aztec/stdlib/tx";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { deriveKeys, deriveSigningKey } from "@aztec/stdlib/keys";

import {
  SchnorrInitializerlessAccountContract,
  SchnorrInitializerlessAccountContractArtifact,
} from "../../artifacts/SchnorrInitializerlessAccount.js";
import * as generic from "../immutables/index.js";
import type {
  ImmutablesInstanceOptions,
  DeployWithImmutablesOptions,
} from "../immutables/index.js";

// Re-export IMMUTABLES_SLOT from generic
export { IMMUTABLES_SLOT } from "../immutables/index.js";

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
  /**
   * The full capsule data: `[actualSalt, ...serializedImmutables]`.
   * Persist this for backup — needed to re-store immutables on a new PXE.
   */
  capsuleData: Fr[];
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serializes the signing public key to Fr[] using the artifact's `#[abi(immutables)]` layout.
 *
 * The Noir struct has a nested `PublicKey` type:
 * ```noir
 * #[immutables]
 * pub struct Immutables {
 *     pub public_key: PublicKey,  // serializes to [x, y]
 * }
 * ```
 *
 * Uses `serializeFromLayout` to map the TypeScript `SigningPublicKey` to the Noir
 * field name and validate against the artifact layout.
 */
export function serializeSigningKey(key: SigningPublicKey): Fr[] {
  return generic.serializeFromLayout(
    SchnorrInitializerlessAccountContractArtifact,
    {
      public_key: [key.x, key.y],
    },
  );
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
export class SchnorrInitializerlessAccount implements AccountContract {
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
 * Creates a SchnorrInitializerlessAccount from a secret key.
 *
 * This derives the signing key pair from the secret and creates
 * an account ready for deployment.
 *
 * @param secretKey - The secret key to derive signing keys from
 * @returns The account with derived signing keys
 */
export async function createSchnorrInitializerlessAccount(
  secretKey: Fr,
): Promise<{
  account: SchnorrInitializerlessAccount;
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

  const account = new SchnorrInitializerlessAccount(
    signingPrivateKey,
    signingPublicKey,
  );

  return { account, signingPrivateKey, signingPublicKey };
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Result of deploying a SchnorrInitializerlessAccount
 */
export interface DeploySchnorrInitializerlessAccountResult {
  /** The deployed contract handle */
  contract: SchnorrInitializerlessAccountContract;
  address: AztecAddress;
  secretKey: Fr;
  signingPrivateKey: GrumpkinScalar;
  signingPublicKey: SigningPublicKey;
  instance: ContractInstanceWithAddress;
  /**
   * The full capsule data: `[actualSalt, ...serializedImmutables]`.
   * Persist this for backup — needed to re-store immutables on a new PXE.
   */
  capsuleData: Fr[];
  /** The Account object — register this with your wallet for signing. */
  account: AccountWithSecretKey;
}

/**
 * Deploys a SchnorrInitializerlessAccount contract.
 *
 * Handles the full lifecycle:
 * 1. Derives signing keys from secret
 * 2. Derives public keys for the contract instance
 * 3. Serializes the signing key using the artifact layout
 * 4. Calls `deployWithImmutables` (salt derivation, PXE registration,
 *    `store_immutables` persistence, and optional publication)
 * 5. Creates the `AccountContract` and `Account` objects for wallet integration
 *
 * The returned `account` can be registered with your wallet for signing.
 * The returned `capsuleData` should be persisted externally for PXE recovery.
 *
 * @param wallet - Any Aztec wallet (not test-specific)
 * @param deployer - The account address that pays fees and sends the publish transaction
 * @param options - Deployment options (secretKey, actualSalt, publication flags, etc.)
 * @returns Everything needed to use the account: contract, keys, capsuleData, account
 */
export async function deploySchnorrInitializerlessAccount(
  wallet: Wallet,
  deployer: AztecAddress,
  options?: DeployWithImmutablesOptions,
): Promise<DeploySchnorrInitializerlessAccountResult> {
  const secretKey = options?.secretKey ?? Fr.random();

  // Derive signing keys
  const signingPrivateKey = deriveSigningKey(secretKey);
  const schnorr = new Schnorr();
  const publicKeyPoint = await schnorr.computePublicKey(signingPrivateKey);
  const signingPublicKey: SigningPublicKey = {
    x: new Fr(publicKeyPoint.x.toBigInt()),
    y: new Fr(publicKeyPoint.y.toBigInt()),
  };

  // Derive public keys for the contract instance
  const { publicKeys } = await deriveKeys(secretKey);

  // Deploy with immutables (handles salt, PXE registration, store_immutables, publication)
  const deployResult = await generic.deployWithImmutables(
    wallet,
    deployer,
    SchnorrInitializerlessAccountContractArtifact,
    serializeSigningKey(signingPublicKey),
    { ...options, publicKeys, secretKey },
  );

  const instance = deployResult.instance;
  const address = instance.address;

  // Create Account for wallet signing integration
  const schnorrAccount = new SchnorrInitializerlessAccount(
    signingPrivateKey,
    signingPublicKey,
  );

  const completeAddress = await CompleteAddress.fromSecretKeyAndInstance(
    secretKey,
    instance,
  );

  const baseAccount = schnorrAccount.getAccount(completeAddress);
  const account = new AccountWithSecretKey(
    baseAccount,
    secretKey,
    instance.salt,
  );

  const contract = SchnorrInitializerlessAccountContract.at(address, wallet);

  return {
    contract,
    address,
    secretKey,
    signingPrivateKey,
    signingPublicKey,
    instance,
    capsuleData: deployResult.capsuleData,
    account,
  };
}
