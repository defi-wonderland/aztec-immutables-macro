/**
 * Generic Initializerless Immutables Utilities
 *
 * This module provides contract-agnostic utilities for the initializerless immutables
 * pattern. Any contract using the `#[immutables]` Noir macro can use these functions
 * by passing its artifact and serialized immutables as `Fr[]`.
 *
 * ## Pattern Overview
 *
 * 1. **Salt derivation**: `salt = poseidon2_hash([actual_salt, ...serialized_immutables])`
 * 2. **Capsule storage**: `[actual_salt, ...serialized_immutables]` pushed to PXE at IMMUTABLES_SLOT
 * 3. **Runtime verification**: Noir hashes capsule data and verifies against `instance.salt`
 *
 * ## Usage
 *
 * ```typescript
 * import { deployWithImmutables, createImmutablesCapsule } from "./immutables/utils.js";
 *
 * // Deploy any contract with immutables
 * const result = await deployWithImmutables(wallet, MyContractArtifact, [field1, field2]);
 *
 * // Create capsule for function calls
 * const capsule = createImmutablesCapsule(result.instance.address, result.actualSalt, [field1, field2]);
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
  getContractInstanceFromInstantiationParams,
} from "@aztec/stdlib/contract";
import { getInitializer } from "@aztec/stdlib/abi";
import type { ContractArtifact, FunctionAbi } from "@aztec/stdlib/abi";
import type {
  ContractInstance,
  ContractInstanceWithAddress,
} from "@aztec/stdlib/contract";
import type { Wallet } from "@aztec/aztec.js/wallet";
import {
  publishContractClass,
  publishInstance,
} from "@aztec/aztec.js/deployment";
import { ContractFunctionInteraction } from "@aztec/aztec.js/contracts";

/**
 * Immutables slot - must match IMMUTABLES_SLOT in the #[immutables] Noir macro.
 * Computed as: poseidon2_hash_bytes("IMMUTABLES_SLOT".as_bytes())
 */
export const IMMUTABLES_SLOT = new Fr(
  0x1a0e563e6a2087002308173ed42dec43b9543a3684de63d6be9a958c0eaf5c45n,
);

// ---------------------------------------------------------------------------
// Low-level building blocks
// ---------------------------------------------------------------------------

/**
 * Computes the contract salt from actual_salt and serialized immutables.
 * Must match the Noir: `poseidon2_hash([actual_salt, ...serialized_immutables])`
 *
 * @param actualSalt - The random salt value stored in the capsule
 * @param serializedImmutables - The immutables serialized as Fr[]
 * @returns The derived salt to use in the contract instance
 */
export function computeContractSalt(
  actualSalt: Fr,
  serializedImmutables: Fr[],
): Fr {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = poseidon2Hash([actualSalt, ...serializedImmutables] as any);
  return new Fr(result.toBigInt());
}

/**
 * Creates a Capsule containing the actual_salt and immutables for a given contract address.
 * This capsule must be passed with any call that reads immutables via `Immutables::init()`.
 *
 * Capsule format: [actual_salt, ...serialized_immutables]
 *
 * @param contractAddress - The contract address to create the capsule for
 * @param actualSalt - The random salt value used during deployment
 * @param serializedImmutables - The immutables serialized as Fr[]
 */
export function createImmutablesCapsule(
  contractAddress: AztecAddress,
  actualSalt: Fr,
  serializedImmutables: Fr[],
): Capsule {
  return new Capsule(contractAddress, IMMUTABLES_SLOT, [
    actualSalt,
    ...serializedImmutables,
  ]);
}

// ---------------------------------------------------------------------------
// Instance creation (no wallet needed)
// ---------------------------------------------------------------------------

/**
 * Result of creating an immutables contract instance
 */
export interface CreateImmutablesInstanceResult {
  instance: ContractInstanceWithAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
}

/**
 * Options for creating an immutables contract instance
 */
export interface ImmutablesInstanceOptions {
  /** Random salt stored in capsule (generated if not provided) */
  actualSalt?: Fr;
  publicKeys?: PublicKeys;
  deployer?: AztecAddress;
  /** Initializer function name or artifact. If provided, initializationHash is computed from it. */
  initializer?: string | FunctionAbi;
  /** Arguments for the initializer function */
  initializerArgs?: any[];
}

/**
 * Creates a contract instance with salt derived from actual_salt and immutables.
 *
 * The contract's salt = poseidon2_hash([actual_salt, ...serialized_immutables]).
 * This allows verification at runtime by hashing the capsule data.
 *
 * @param artifact - The contract artifact
 * @param serializedImmutables - The immutables serialized as Fr[]
 * @param options - Optional deployment options
 * @returns The contract instance with address and the actual_salt for capsule creation
 */
export async function createImmutablesInstance(
  artifact: ContractArtifact,
  serializedImmutables: Fr[],
  options?: ImmutablesInstanceOptions,
): Promise<CreateImmutablesInstanceResult> {
  const actualSalt = options?.actualSalt ?? Fr.random();
  const salt = computeContractSalt(actualSalt, serializedImmutables);

  let instance: ContractInstanceWithAddress;

  if (options?.initializer || options?.initializerArgs) {
    // Use aztec's instance creation which computes initializationHash from constructor
    instance = await getContractInstanceFromInstantiationParams(artifact, {
      constructorArtifact: options.initializer,
      constructorArgs: options.initializerArgs ?? [],
      salt,
      publicKeys: options?.publicKeys ?? PublicKeys.default(),
      deployer: options?.deployer ?? AztecAddress.ZERO,
    });
  } else {
    // No initializer path: initializationHash = Fr.ZERO
    const contractClass = await getContractClassFromArtifact(artifact);
    const rawInstance: ContractInstance = {
      version: 1,
      salt,
      deployer: options?.deployer ?? AztecAddress.ZERO,
      currentContractClassId: contractClass.id,
      originalContractClassId: contractClass.id,
      initializationHash: Fr.ZERO,
      publicKeys: options?.publicKeys ?? PublicKeys.default(),
    };
    const address = await computeContractAddressFromInstance(rawInstance);
    instance = { ...rawInstance, address };
  }

  return { instance, actualSalt };
}

/**
 * Pre-computes the contract address for given immutables without deploying.
 *
 * @param artifact - The contract artifact
 * @param serializedImmutables - The immutables serialized as Fr[]
 * @param options - Optional address computation options
 * @returns The contract address and actual_salt for capsule creation
 */
export async function computeImmutablesAddress(
  artifact: ContractArtifact,
  serializedImmutables: Fr[],
  options?: ImmutablesInstanceOptions,
): Promise<{ address: AztecAddress; actualSalt: Fr }> {
  const { instance, actualSalt } = await createImmutablesInstance(
    artifact,
    serializedImmutables,
    options,
  );
  return { address: instance.address, actualSalt };
}

// ---------------------------------------------------------------------------
// Full deployment (register + optionally publish)
// ---------------------------------------------------------------------------

/**
 * Result of deploying a contract with immutables
 */
export interface DeployWithImmutablesResult {
  instance: ContractInstanceWithAddress;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
}

/**
 * Options for deploying a contract with immutables
 */
export interface DeployWithImmutablesOptions extends ImmutablesInstanceOptions {
  skipClassPublication?: boolean;
  /** Skip publishing the contract instance on-chain. Private execution still works. */
  skipInstancePublication?: boolean;
  /** Secret key for account contract registration (passed to wallet.registerContract) */
  secretKey?: Fr;
}

/**
 * Deploys any contract using the initializerless immutables pattern.
 *
 * Handles the full lifecycle:
 * 1. Generates random actual_salt (or uses provided)
 * 2. Computes salt = poseidon2Hash([actual_salt, ...serialized_immutables])
 * 3. Creates contract instance with this salt
 * 4. Registers the contract with the wallet (PXE)
 * 5. Optionally publishes contract class and instance on-chain
 *
 * @param wallet - The wallet to deploy with
 * @param artifact - The contract artifact
 * @param serializedImmutables - The immutables serialized as Fr[]
 * @param options - Optional deployment options
 * @returns The deployed instance, actualSalt, and publication status
 */
export async function deployWithImmutables(
  wallet: Wallet,
  artifact: ContractArtifact,
  serializedImmutables: Fr[],
  options?: DeployWithImmutablesOptions,
): Promise<DeployWithImmutablesResult> {
  const deployerAddress = (await wallet.getAccounts())[0]!.item;

  // Create contract instance with immutables committed via salt
  const { instance, actualSalt } = await createImmutablesInstance(
    artifact,
    serializedImmutables,
    options,
  );

  // Register the contract with the wallet (PXE)
  await wallet.registerContract(instance, artifact, options?.secretKey);

  // Persist immutables to PXE's CapsuleStore via the store_immutables utility function.
  // This makes immutables available for all subsequent calls without transient capsules.
  const capsuleData = [actualSalt, ...serializedImmutables];
  const storeImmutablesAbi = artifact.functions.find(
    (f) => f.name === "store_immutables",
  );
  if (storeImmutablesAbi) {
    const storeCall = new ContractFunctionInteraction(
      wallet,
      instance.address,
      storeImmutablesAbi,
      [capsuleData],
    );
    await storeCall.simulate({ from: deployerAddress });
  }

  if (!options?.skipInstancePublication) {
    // Create capsule with [actual_salt, ...serialized_immutables]
    const capsule = createImmutablesCapsule(
      instance.address,
      actualSalt,
      serializedImmutables,
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

    // Call initializer if provided
    if (options?.initializer || options?.initializerArgs) {
      const initializerAbi =
        typeof options.initializer === "string" || !options.initializer
          ? getInitializer(artifact, options.initializer)
          : options.initializer;
      if (initializerAbi) {
        const constructorCall = new ContractFunctionInteraction(
          wallet,
          instance.address,
          initializerAbi,
          options.initializerArgs ?? [],
        );
        payloads.push(await constructorCall.request());
      }
    }

    // Send as a single merged transaction
    const merged = mergeExecutionPayloads(payloads);
    await wallet.sendTx(merged, { from: deployerAddress });
  }

  return { instance, actualSalt };
}
