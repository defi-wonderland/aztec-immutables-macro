/**
 * SchnorrConstantsAccountContract - AccountContract implementation for initializerless pattern
 *
 * This provides the AccountContract interface needed to integrate SchnorrConstantsAccount
 * with the Aztec wallet system, enabling it to sign transactions and interact with other contracts.
 *
 * ## Key Differences from Standard SchnorrAccountContract:
 *
 * | Feature | Standard | Constants Pattern |
 * |---------|----------|-------------------|
 * | Initializer | constructor() stores key | None |
 * | Key Storage | SinglePrivateImmutable | Capsule storage |
 * | Salt | Random | hash([actual_salt, public_key.x, public_key.y]) |
 * | Deployment | AccountManager.getDeployMethod() | Custom publishInstance() |
 *
 * ## Usage:
 *
 * ```typescript
 * const signingKey = deriveSigningKey(secretKey);
 * const contract = new SchnorrConstantsAccountContract(signingPrivateKey, signingPublicKey);
 * const accountManager = await AccountManager.create(wallet, secretKey, contract, salt);
 * ```
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

import { SchnorrConstantsAccountContractArtifact } from "../../artifacts/SchnorrConstantsAccount.js";

/**
 * Signing public key type (Grumpkin curve point coordinates)
 */
export interface SigningPublicKey {
  x: Fr;
  y: Fr;
}

/**
 * AccountContract implementation for SchnorrConstantsAccount.
 *
 * This class enables the initializerless constants account to work with
 * the Aztec wallet system for transaction signing.
 */
export class SchnorrConstantsAccountContract implements AccountContract {
  constructor(
    private signingPrivateKey: GrumpkinScalar,
    private signingPublicKey: SigningPublicKey,
  ) {}

  /**
   * Returns undefined since SchnorrConstantsAccount has no initializer.
   *
   * The contract's salt is computed from the signing key and passed
   * to the contract instance creation. initializationHash is set to zero.
   */
  async getInitializationFunctionAndArgs(): Promise<undefined> {
    return undefined;
  }

  /**
   * Returns the SchnorrConstantsAccount contract artifact.
   */
  async getContractArtifact(): Promise<ContractArtifact> {
    return SchnorrConstantsAccountContractArtifact;
  }

  /**
   * Returns an AuthWitnessProvider that creates Schnorr signatures.
   *
   * The signing is identical to the standard SchnorrAccount - both use
   * Schnorr signatures. The difference is only in how the contract verifies
   * the signature (capsule vs SinglePrivateImmutable storage).
   */
  getAuthWitnessProvider(_address: CompleteAddress): AuthWitnessProvider {
    return new SchnorrConstantsAuthWitnessProvider(this.signingPrivateKey);
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

/**
 * AuthWitnessProvider for SchnorrConstantsAccount.
 *
 * Creates Schnorr signatures for transaction authorization.
 * Identical to the standard SchnorrAuthWitnessProvider.
 */
export class SchnorrConstantsAuthWitnessProvider implements AuthWitnessProvider {
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

/**
 * Creates a SchnorrConstantsAccountContract from a secret key.
 *
 * This derives the signing key pair from the secret and creates
 * an account contract ready for deployment.
 *
 * @param secretKey - The secret key to derive signing keys from
 * @returns The account contract with derived signing keys
 */
export async function createSchnorrConstantsAccountContract(
  secretKey: Fr,
): Promise<{
  contract: SchnorrConstantsAccountContract;
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

  const contract = new SchnorrConstantsAccountContract(
    signingPrivateKey,
    signingPublicKey,
  );

  return { contract, signingPrivateKey, signingPublicKey };
}
