/**
 * Generic Initializerless Constants Utilities
 *
 * This module provides contract-agnostic utilities for the initializerless constants
 * pattern. Any contract using the `#[constants]` Noir macro can use these functions
 * by passing its artifact and serialized constants as `Fr[]`.
 *
 * ## Pattern Overview
 *
 * 1. **Salt derivation**: `salt = poseidon2_hash([actual_salt, ...serialized_constants])`
 * 2. **Capsule storage**: `[actual_salt, ...serialized_constants]` pushed to PXE at CONSTANTS_SLOT
 * 3. **Runtime verification**: Noir hashes capsule data and verifies against `instance.salt`
 *
 * ## Usage
 *
 * ```typescript
 * import { deployWithConstants, createConstantsCapsule } from "./initializerless/utils.js";
 *
 * // Deploy any contract with constants
 * const result = await deployWithConstants(wallet, MyContractArtifact, [field1, field2]);
 *
 * // Create capsule for function calls
 * const capsule = createConstantsCapsule(result.instance.address, result.actualSalt, [field1, field2]);
 * ```
 */

import { Fr } from "@aztec/aztec.js/fields";
import { poseidon2Hash } from "@aztec/foundation/crypto/sync";
import {
  Capsule,
  ExecutionPayload,
  mergeExecutionPayloads,
} from "@aztec/stdlib/tx";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { PublicKeys } from "@aztec/stdlib/keys";
import {
  computeContractAddressFromInstance,
  getContractClassFromArtifact,
} from "@aztec/stdlib/contract";
import type { ContractArtifact } from "@aztec/stdlib/abi";
import type {
  ContractInstance,
  ContractInstanceWithAddress,
} from "@aztec/stdlib/contract";
import type { Wallet } from "@aztec/aztec.js/wallet";
import {
  publishContractClass,
  publishInstance,
} from "@aztec/aztec.js/deployment";

/**
 * Constants slot - must match CONSTANTS_SLOT in the #[constants] Noir macro.
 * Computed as: poseidon2_hash_bytes("CONSTANTS_SLOT".as_bytes())
 */
export const CONSTANTS_SLOT = new Fr(
  0x257f7fa8d0b607b4f584f2aa6480ae86716203481e2802444cf05a289cc85b3an,
);

// ---------------------------------------------------------------------------
// Low-level building blocks
// ---------------------------------------------------------------------------

/**
 * Computes the contract salt from actual_salt and serialized constants.
 * Must match the Noir: `poseidon2_hash([actual_salt, ...serialized_constants])`
 *
 * @param actualSalt - The random salt value stored in the capsule
 * @param serializedConstants - The constants serialized as Fr[]
 * @returns The derived salt to use in the contract instance
 */
export function computeContractSalt(
  actualSalt: Fr,
  serializedConstants: Fr[],
): Fr {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = poseidon2Hash([actualSalt, ...serializedConstants] as any);
  return new Fr(result.toBigInt());
}

/**
 * Creates a Capsule containing the actual_salt and constants for a given contract address.
 * This capsule must be passed with any call that reads constants via `Constants::init()`.
 *
 * Capsule format: [actual_salt, ...serialized_constants]
 *
 * @param contractAddress - The contract address to create the capsule for
 * @param actualSalt - The random salt value used during deployment
 * @param serializedConstants - The constants serialized as Fr[]
 */
export function createConstantsCapsule(
  contractAddress: AztecAddress,
  actualSalt: Fr,
  serializedConstants: Fr[],
): Capsule {
  return new Capsule(contractAddress, CONSTANTS_SLOT, [
    actualSalt,
    ...serializedConstants,
  ]);
}

// ---------------------------------------------------------------------------
// Instance creation (no wallet needed)
// ---------------------------------------------------------------------------

/**
 * Result of creating a constants contract instance
 */
export interface CreateConstantsInstanceResult {
  instance: ContractInstanceWithAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
}

/**
 * Options for creating a constants contract instance
 */
export interface ConstantsInstanceOptions {
  /** Random salt stored in capsule (generated if not provided) */
  actualSalt?: Fr;
  publicKeys?: PublicKeys;
  deployer?: AztecAddress;
}

/**
 * Creates a contract instance with salt derived from actual_salt and constants.
 *
 * The contract's salt = poseidon2_hash([actual_salt, ...serialized_constants]).
 * This allows verification at runtime by hashing the capsule data.
 *
 * @param artifact - The contract artifact
 * @param serializedConstants - The constants serialized as Fr[]
 * @param options - Optional deployment options
 * @returns The contract instance with address and the actual_salt for capsule creation
 */
export async function createConstantsInstance(
  artifact: ContractArtifact,
  serializedConstants: Fr[],
  options?: ConstantsInstanceOptions,
): Promise<CreateConstantsInstanceResult> {
  const actualSalt = options?.actualSalt ?? Fr.random();
  const publicKeys = options?.publicKeys ?? PublicKeys.default();
  const deployer = options?.deployer ?? AztecAddress.ZERO;

  const contractClass = await getContractClassFromArtifact(artifact);
  const salt = computeContractSalt(actualSalt, serializedConstants);

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
 * Pre-computes the contract address for given constants without deploying.
 *
 * @param artifact - The contract artifact
 * @param serializedConstants - The constants serialized as Fr[]
 * @param options - Optional address computation options
 * @returns The contract address and actual_salt for capsule creation
 */
export async function computeConstantsAddress(
  artifact: ContractArtifact,
  serializedConstants: Fr[],
  options?: ConstantsInstanceOptions,
): Promise<{ address: AztecAddress; actualSalt: Fr }> {
  const { instance, actualSalt } = await createConstantsInstance(
    artifact,
    serializedConstants,
    options,
  );
  return { address: instance.address, actualSalt };
}

// ---------------------------------------------------------------------------
// Full deployment (register + optionally publish)
// ---------------------------------------------------------------------------

/**
 * Result of deploying a contract with constants
 */
export interface DeployWithConstantsResult {
  instance: ContractInstanceWithAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
  /** Whether the contract instance was published on-chain */
  isPublished: boolean;
}

/**
 * Options for deploying a contract with constants
 */
export interface DeployWithConstantsOptions extends ConstantsInstanceOptions {
  skipClassPublication?: boolean;
  /** Skip publishing the contract instance on-chain. Private execution still works. */
  skipInstancePublication?: boolean;
  /** Secret key for account contract registration (passed to wallet.registerContract) */
  secretKey?: Fr;
}

/**
 * Deploys any contract using the initializerless constants pattern.
 *
 * Handles the full lifecycle:
 * 1. Generates random actual_salt (or uses provided)
 * 2. Computes salt = poseidon2Hash([actual_salt, ...serialized_constants])
 * 3. Creates contract instance with this salt
 * 4. Registers the contract with the wallet (PXE)
 * 5. Optionally publishes contract class and instance on-chain
 *
 * @param wallet - The wallet to deploy with
 * @param artifact - The contract artifact
 * @param serializedConstants - The constants serialized as Fr[]
 * @param options - Optional deployment options
 * @returns The deployed instance, actualSalt, and publication status
 */
export async function deployWithConstants(
  wallet: Wallet,
  artifact: ContractArtifact,
  serializedConstants: Fr[],
  options?: DeployWithConstantsOptions,
): Promise<DeployWithConstantsResult> {
  const deployerAddress = (await wallet.getAccounts())[0]!.item;

  // Create contract instance with constants committed via salt
  const { instance, actualSalt } = await createConstantsInstance(
    artifact,
    serializedConstants,
    options,
  );

  // Register the contract with the wallet (PXE)
  await wallet.registerContract(instance, artifact, options?.secretKey);

  let isPublished = false;

  if (!options?.skipInstancePublication) {
    // Create capsule with [actual_salt, ...serialized_constants]
    const capsule = createConstantsCapsule(
      instance.address,
      actualSalt,
      serializedConstants,
    );

    // Build execution payloads and merge into a single atomic transaction
    // (mirrors how DeployMethod merges class + instance publication)
    const payloads: ExecutionPayload[] = [];

    // Publish the contract class if not skipped
    if (!options?.skipClassPublication) {
      const contractClass = await getContractClassFromArtifact(artifact);
      const metadata = await wallet.getContractClassMetadata(contractClass.id);

      if (!metadata.isContractClassPubliclyRegistered) {
        const publishClassInteraction = await publishContractClass(
          wallet,
          artifact,
        );
        payloads.push(await publishClassInteraction.request());
      }
    }

    // Publish the contract instance
    const publishInstanceInteraction = publishInstance(wallet, instance);
    payloads.push(
      await publishInstanceInteraction.with({ capsules: [capsule] }).request(),
    );

    // Send as a single merged transaction
    const merged = mergeExecutionPayloads(payloads);
    await wallet.sendTx(merged, { from: deployerAddress });

    isPublished = true;
  }

  return { instance, actualSalt, isPublished };
}
