/**
 * SchnorrConstantsAccount Test Utilities
 *
 * Provides test infrastructure for deploying SchnorrConstantsAccount and
 * integrating it with TestWallet so it can sign transactions in tests.
 *
 * This is NOT production code — it uses TestWallet-specific workarounds.
 *
 * ## The Challenge
 *
 * The standard AccountManager flow computes salt randomly, but SchnorrConstantsAccount
 * uses a derived salt that commits to the signing key:
 * - Standard: random salt
 * - Constants: salt = hash([actual_salt, public_key.x, public_key.y])
 *
 * This module provides a custom deployment path that:
 * 1. Computes the correct salt for the constants pattern
 * 2. Deploys the contract with this derived salt
 * 3. Creates the Account object for signing
 * 4. Registers everything with the wallet
 */

import { AccountWithSecretKey } from "@aztec/aztec.js/account";
import type { TestWallet } from "@aztec/test-wallet/server";
import { Fr, GrumpkinScalar } from "@aztec/aztec.js/fields";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { deriveKeys, deriveSigningKey } from "@aztec/stdlib/keys";
import { CompleteAddress } from "@aztec/stdlib/contract";

import {
  SchnorrConstantsAccountContract,
  SchnorrConstantsAccountContractArtifact,
} from "../../artifacts/SchnorrConstantsAccount.js";
import {
  SchnorrConstantsAccountContract as SchnorrConstantsAccountContractClass,
  serializeSigningKey,
  createSigningKeyCapsule,
  type SigningPublicKey,
} from "./index.js";
import { deployWithConstants } from "../initializerless/utils.js";
import type { DeployWithConstantsOptions } from "../initializerless/utils.js";

export { CONSTANTS_SLOT } from "../initializerless/utils.js";

/**
 * Result of deploying a SchnorrConstantsAccount for wallet integration
 */
export interface DeployedSchnorrConstantsAccount {
  contract: SchnorrConstantsAccountContract;
  address: AztecAddress;
  secretKey: Fr;
  signingPrivateKey: GrumpkinScalar;
  signingPublicKey: SigningPublicKey;
  instance: import("@aztec/stdlib/contract").ContractInstanceWithAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
  /** Whether the contract instance was published on-chain */
  isPublished: boolean;
}

/**
 * Deploys SchnorrConstantsAccount and registers it with TestWallet for signing.
 *
 * This function handles the full lifecycle:
 * 1. Derives signing keys from secret
 * 2. Generates random actual_salt
 * 3. Computes salt = poseidon2_hash([actual_salt, public_key.x, public_key.y])
 * 4. Creates contract instance with this derived salt
 * 5. Optionally publishes the contract class and instance
 * 6. Creates Account object with SchnorrAuthWitnessProvider
 * 7. Registers the account with TestWallet
 *
 * ## Publication vs PXE-Only Registration
 *
 * By default, the contract is published on-chain. However, since SchnorrConstantsAccount
 * has only private functions, it can work without publication:
 * - `skipInstancePublication: true` - Contract only registered in PXE, not on-chain
 * - Private execution still works (validated locally)
 * - Other parties cannot discover the contract on-chain
 *
 * @param wallet - TestWallet to deploy with and register to
 * @param options - Optional deployment configuration
 * @returns The deployed account details including actualSalt for capsule creation
 */
export async function registerConstantsAccount(
  wallet: TestWallet,
  options?: {
    secretKey?: Fr;
    /** Random salt stored in capsule (generated if not provided) */
    actualSalt?: Fr;
    skipClassPublication?: boolean;
    /** Skip publishing the contract instance on-chain. Private execution still works. */
    skipInstancePublication?: boolean;
  },
): Promise<DeployedSchnorrConstantsAccount> {
  const secretKey = options?.secretKey ?? Fr.random();

  // Derive signing private key from secret
  const signingPrivateKey = deriveSigningKey(secretKey);

  // Derive signing public key from private key using Schnorr
  const schnorr = new Schnorr();
  const publicKeyPoint = await schnorr.computePublicKey(signingPrivateKey);
  const signingPublicKey: SigningPublicKey = {
    x: new Fr(publicKeyPoint.x.toBigInt()),
    y: new Fr(publicKeyPoint.y.toBigInt()),
  };

  // Derive public keys for the contract instance
  const { publicKeys } = await deriveKeys(secretKey);

  // Use the generic deployWithConstants for instance creation, registration, and publication
  const deployOpts: DeployWithConstantsOptions = {
    actualSalt: options?.actualSalt,
    publicKeys,
    secretKey,
    skipClassPublication: options?.skipClassPublication,
    skipInstancePublication: options?.skipInstancePublication,
  };

  const deployResult = await deployWithConstants(
    wallet,
    SchnorrConstantsAccountContractArtifact,
    serializeSigningKey(signingPublicKey),
    deployOpts,
  );

  const instanceWithAddress = deployResult.instance;
  const address = instanceWithAddress.address;

  // Create AccountContract and Account for signing
  const accountContract = new SchnorrConstantsAccountContractClass(
    signingPrivateKey,
    signingPublicKey,
  );

  // Create CompleteAddress for the account interface
  const completeAddress = await CompleteAddress.fromSecretKeyAndInstance(
    secretKey,
    instanceWithAddress,
  );

  // Create account and wrap with secret key
  const baseAccount = accountContract.getAccount(completeAddress);
  const account = new AccountWithSecretKey(
    baseAccount,
    secretKey,
    instanceWithAddress.salt,
  );

  // Register the account with the wallet for signing
  // Access the internal accounts map through a workaround
  // @ts-ignore - accessing protected member for benchmark purposes
  if (wallet.accounts) {
    // @ts-ignore
    wallet.accounts.set(address.toString(), account);
  }

  // Get the contract instance
  const contract = SchnorrConstantsAccountContract.at(address, wallet);

  return {
    contract,
    address,
    secretKey,
    signingPrivateKey,
    signingPublicKey,
    instance: instanceWithAddress,
    actualSalt: deployResult.actualSalt,
    isPublished: deployResult.isPublished,
  };
}

// Re-export createSigningKeyCapsule from index for convenience
export { createSigningKeyCapsule } from "./index.js";
