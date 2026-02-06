/**
 * SchnorrConstantsAccount Wallet Integration
 *
 * This module provides utilities to deploy SchnorrConstantsAccount and integrate
 * it with TestWallet so it can sign transactions and interact with other contracts.
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
import {
  computeContractAddressFromInstance,
  getContractClassFromArtifact,
  CompleteAddress,
} from "@aztec/stdlib/contract";
import type {
  ContractInstance,
  ContractInstanceWithAddress,
} from "@aztec/stdlib/contract";
import {
  publishContractClass,
  publishInstance,
} from "@aztec/aztec.js/deployment";

import {
  SchnorrConstantsAccountContract,
  SchnorrConstantsAccountContractArtifact,
} from "../../artifacts/SchnorrConstantsAccount.js";
import {
  SchnorrConstantsAccountContract as SchnorrConstantsAccountContractClass,
  type SigningPublicKey,
} from "./contract.js";
import {
  computeContractSalt,
  createSigningKeyCapsule as createCapsule,
  CONSTANTS_SLOT,
} from "./utils.js";

export { CONSTANTS_SLOT };

/**
 * Result of deploying a SchnorrConstantsAccount for wallet integration
 */
export interface DeployedSchnorrConstantsAccount {
  contract: SchnorrConstantsAccountContract;
  address: AztecAddress;
  secretKey: Fr;
  signingPrivateKey: GrumpkinScalar;
  signingPublicKey: SigningPublicKey;
  instance: ContractInstanceWithAddress;
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
  const actualSalt = options?.actualSalt ?? Fr.random();

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

  // Compute salt = poseidon2_hash([actual_salt, public_key.x, public_key.y])
  const salt = await computeContractSalt(actualSalt, signingPublicKey);

  // Get contract class
  const contractClass = await getContractClassFromArtifact(
    SchnorrConstantsAccountContractArtifact,
  );

  // Create contract instance
  const instance: ContractInstance = {
    version: 1,
    salt,
    deployer: AztecAddress.ZERO,
    currentContractClassId: contractClass.id,
    originalContractClassId: contractClass.id,
    initializationHash: Fr.ZERO, // No initializer
    publicKeys,
  };

  const address = await computeContractAddressFromInstance(instance);
  const instanceWithAddress: ContractInstanceWithAddress = {
    ...instance,
    address,
  };

  // Create capsule with [actual_salt, public_key.x, public_key.y]
  const capsule = createCapsule(address, actualSalt, signingPublicKey);

  // Get deployer address
  const accounts = await wallet.getAccounts();
  const deployerAddress = accounts[0]!.item;

  // Register the contract with the wallet
  await wallet.registerContract(
    instanceWithAddress,
    SchnorrConstantsAccountContractArtifact,
    secretKey,
  );

  // Track whether we published the instance
  let isPublished = false;

  // Only publish if not skipping instance publication
  if (!options?.skipInstancePublication) {
    // Publish contract class if needed
    if (!options?.skipClassPublication) {
      const metadata = await wallet.getContractClassMetadata(contractClass.id);
      if (!metadata.isContractClassPubliclyRegistered) {
        const publishClassInteraction = await publishContractClass(
          wallet,
          SchnorrConstantsAccountContractArtifact,
        );
        await publishClassInteraction.send({ from: deployerAddress });
      }
    }

    // Publish the contract instance with capsule
    const publishInstanceInteraction = await publishInstance(
      wallet,
      instanceWithAddress,
    );
    await publishInstanceInteraction
      .with({ capsules: [capsule] })
      .send({ from: deployerAddress });

    isPublished = true;
  }

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
  const account = new AccountWithSecretKey(baseAccount, secretKey, salt);

  // Register the account with the wallet for signing
  // Access the internal accounts map through a workaround
  // @ts-ignore - accessing protected member for benchmark purposes
  if (wallet.accounts) {
    // @ts-ignore
    wallet.accounts.set(address.toString(), account);
  }

  // Get the contract instance
  const contract = await SchnorrConstantsAccountContract.at(address, wallet);

  return {
    contract,
    address,
    secretKey,
    signingPrivateKey,
    signingPublicKey,
    instance: instanceWithAddress,
    actualSalt,
    isPublished,
  };
}

// Re-export createSigningKeyCapsule from utils
export { createSigningKeyCapsule } from "./utils.js";
