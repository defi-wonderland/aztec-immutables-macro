/**
 * SchnorrConstantsAccount Utilities
 *
 * Low-level utilities for working with the SchnorrConstantsAccount contract,
 * which uses the initializerless constants pattern for storing the signing public key.
 *
 * ## How Salt Verification Works
 *
 * 1. TypeScript generates a random `actual_salt`
 * 2. Computes `salt = poseidon2_hash([actual_salt, public_key.x, public_key.y])`
 * 3. Creates contract instance with this `salt`
 * 4. Capsule stores `[actual_salt, public_key.x, public_key.y]`
 * 5. At runtime, Noir hashes capsule data and verifies against `instance.salt`
 *
 * ## Usage
 *
 * For deployment, use `registerConstantsAccount` from the wallet-integration module.
 * This module provides lower-level utilities for:
 * - Computing contract salts and addresses
 * - Creating capsules for function calls
 * - Creating contract instances
 */

import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/sync";
import { Capsule } from "@aztec/stdlib/tx";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { PublicKeys } from "@aztec/stdlib/keys";
import {
  computeContractAddressFromInstance,
  getContractClassFromArtifact,
} from "@aztec/stdlib/contract";
import type {
  ContractInstance,
  ContractInstanceWithAddress,
} from "@aztec/stdlib/contract";
import { SchnorrConstantsAccountContractArtifact } from "../../artifacts/SchnorrConstantsAccount.js";

/**
 * Constants slot - must match CONSTANTS_SLOT in Noir contract
 * Computed as: poseidon2_hash_bytes("CONSTANTS_SLOT".as_bytes())
 */
export const CONSTANTS_SLOT = new Fr(
  0x257f7fa8d0b607b4f584f2aa6480ae86716203481e2802444cf05a289cc85b3an,
);

/**
 * Signing public key type (Grumpkin curve point coordinates)
 */
export interface SigningPublicKey {
  x: Fr;
  y: Fr;
}

/**
 * Serializes the signing public key to Fr array (matches Noir serialization)
 */
export function serializeSigningKey(key: SigningPublicKey): Fr[] {
  return [key.x, key.y];
}

/**
 * Computes the contract salt from actual_salt and signing public key.
 * This must match the Noir: poseidon2_hash([actual_salt, public_key.x, public_key.y])
 *
 * @param actualSalt - The random salt value stored in the capsule
 * @param key - The signing public key
 * @returns The derived salt to use in the contract instance
 */
export async function computeContractSalt(
  actualSalt: Fr,
  key: SigningPublicKey,
): Promise<Fr> {
  const capsuleData = [actualSalt, ...serializeSigningKey(key)];
  const result = await poseidon2Hash(capsuleData as any);
  return new Fr(result.toBigInt());
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
  const data = [actualSalt, ...serializeSigningKey(key)];
  return new Capsule(contractAddress, CONSTANTS_SLOT, data);
}

/**
 * Result of creating a contract instance, includes the actual_salt needed for capsules
 */
export interface SchnorrAccountInstanceResult {
  instance: ContractInstanceWithAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
}

/**
 * Creates a contract instance with salt derived from actual_salt and signing key.
 *
 * The contract's salt field = poseidon2_hash([actual_salt, public_key.x, public_key.y])
 * This allows verification at runtime by hashing the capsule data.
 *
 * @param signingKey - The signing public key to commit
 * @param options - Optional deployment options (actualSalt, publicKeys, deployer)
 * @returns The contract instance with address and the actual_salt for capsule creation
 */
export async function createSchnorrAccountInstance(
  signingKey: SigningPublicKey,
  options?: {
    /** Random salt stored in capsule (generated if not provided) */
    actualSalt?: Fr;
    publicKeys?: PublicKeys;
    deployer?: AztecAddress;
  },
): Promise<SchnorrAccountInstanceResult> {
  const actualSalt = options?.actualSalt ?? Fr.random();
  const publicKeys = options?.publicKeys ?? PublicKeys.default();
  const deployer = options?.deployer ?? AztecAddress.ZERO;

  const contractClass = await getContractClassFromArtifact(
    SchnorrConstantsAccountContractArtifact,
  );

  // Compute salt = poseidon2Hash([actual_salt, public_key.x, public_key.y])
  const salt = await computeContractSalt(actualSalt, signingKey);

  const instance: ContractInstance = {
    version: 1,
    salt,
    deployer,
    currentContractClassId: contractClass.id,
    originalContractClassId: contractClass.id,
    initializationHash: Fr.ZERO, // No initializer
    publicKeys,
  };

  const address = await computeContractAddressFromInstance(instance);
  return { instance: { ...instance, address }, actualSalt };
}

/**
 * Result of computing a contract address
 */
export interface ComputeSchnorrAccountAddressResult {
  address: AztecAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
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
  options?: {
    actualSalt?: Fr;
    publicKeys?: PublicKeys;
    deployer?: AztecAddress;
  },
): Promise<ComputeSchnorrAccountAddressResult> {
  const { instance, actualSalt } = await createSchnorrAccountInstance(
    signingKey,
    options,
  );
  return { address: instance.address, actualSalt };
}
