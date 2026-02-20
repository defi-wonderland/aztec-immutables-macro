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
 * import { deployWithImmutables } from "./immutables/utils.js";
 *
 * // Deploy any contract with immutables
 * const { instance, capsuleData } = await deployWithImmutables(wallet, MyContractArtifact, [field1, field2]);
 *
 * // Persist capsuleData for backup (needed for PXE recovery)
 * // capsuleData = [actualSalt, field1, field2]
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
import type {
  ContractArtifact,
  FunctionAbi,
  StructValue,
  IntegerValue,
  TypedStructFieldValue,
  BasicValue,
} from "@aztec/stdlib/abi";
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
// Artifact introspection
// ---------------------------------------------------------------------------

/**
 * A single immutable field's layout entry.
 */
export interface ImmutableFieldLayout {
  /** Index of this field in the serialized Fr[] array */
  index: number;
}

/**
 * Parsed immutables layout from a contract artifact.
 */
export interface ImmutablesLayout {
  /** Total number of serialized Fr elements (accounts for nested struct flattening) */
  serializedLen: number;
  /** Map of field names to their layout entries */
  fields: Record<string, ImmutableFieldLayout>;
}

/**
 * Parses the immutables layout from a contract artifact.
 *
 * The `#[immutables]` Noir macro emits an `#[abi(immutables)]` global that the compiler
 * collects into `outputs.globals.immutables` in the artifact JSON. This function parses
 * that structure into a typed layout with field names, serialization indices, and total
 * serialized length.
 *
 * Mirrors `getStorageLayout()` from aztec-packages (stdlib/src/abi/contract_artifact.ts).
 *
 * @param artifact - The contract artifact to extract immutables layout from
 * @returns The parsed layout, or null if the contract has no immutables
 */
export function getImmutablesLayout(
  artifact: ContractArtifact,
): ImmutablesLayout | null {
  const immutablesExports = artifact.outputs.globals.immutables
    ? (artifact.outputs.globals.immutables as StructValue[])
    : [];

  // Find the entry matching this contract (imported contracts may leak their layout)
  const layoutForContract = immutablesExports.find((entry) => {
    const contractNameField = entry.fields.find(
      (field) => field.name === "contract_name",
    )?.value as BasicValue<"string", string> | undefined;
    return contractNameField?.value === artifact.name;
  });

  if (!layoutForContract) {
    return null;
  }

  // Extract serialized_len
  const serializedLenValue = layoutForContract.fields.find(
    (field) => field.name === "serialized_len",
  )?.value as IntegerValue | undefined;
  const serializedLen = serializedLenValue
    ? parseInt(serializedLenValue.value, 16)
    : 0;

  // Extract the `fields` struct
  const fieldsStruct = layoutForContract.fields.find(
    (field) => field.name === "fields",
  ) as TypedStructFieldValue<StructValue> | undefined;

  if (!fieldsStruct) {
    return { serializedLen, fields: {} };
  }

  const layoutFields = fieldsStruct.value
    .fields as TypedStructFieldValue<StructValue>[];

  const fields = layoutFields.reduce(
    (acc: Record<string, ImmutableFieldLayout>, field) => {
      const indexValue = field.value.fields.find((f) => f.name === "index")
        ?.value as IntegerValue;
      acc[field.name] = {
        index: parseInt(indexValue.value, 16),
      };
      return acc;
    },
    {},
  );

  return { serializedLen, fields };
}

/**
 * Serializes immutable values into an Fr[] array using the artifact's layout.
 *
 * Uses `getImmutablesLayout()` to determine field ordering and validates that:
 * - All layout fields are provided (no missing fields)
 * - No extra fields are provided (no unknown fields)
 * - The total flattened length matches `serialized_len`
 *
 * Values can be a single `Fr` (for `Field`-type immutables) or `Fr[]` (for nested
 * structs like `PublicKey` that serialize to multiple elements).
 *
 * @example
 * ```typescript
 * // Flat fields (Field type)
 * serializeFromLayout(artifact, {
 *   signing_key_x: new Fr(111n),
 *   signing_key_y: new Fr(222n),
 * });
 *
 * // Nested struct (PublicKey type → [x, y])
 * serializeFromLayout(artifact, {
 *   public_key: [new Fr(111n), new Fr(222n)],
 * });
 * ```
 *
 * @param artifact - The contract artifact (must have `#[abi(immutables)]` layout)
 * @param values - Map of Noir field names to their Fr value(s)
 * @returns The serialized Fr[] array in the correct order
 */
export function serializeFromLayout(
  artifact: ContractArtifact,
  values: Record<string, Fr | Fr[]>,
): Fr[] {
  const layout = getImmutablesLayout(artifact);
  if (!layout) {
    throw new Error(
      `Contract artifact "${artifact.name}" has no #[abi(immutables)] layout`,
    );
  }

  const layoutFieldNames = Object.keys(layout.fields);

  // Validate all layout fields are provided
  for (const name of layoutFieldNames) {
    if (!(name in values)) {
      throw new Error(
        `Missing immutable field "${name}". Expected: ${layoutFieldNames.join(", ")}`,
      );
    }
  }

  // Validate no extra fields provided
  for (const name of Object.keys(values)) {
    if (!(name in layout.fields)) {
      throw new Error(
        `Unknown immutable field "${name}". Expected: ${layoutFieldNames.join(", ")}`,
      );
    }
  }

  // Sort fields by layout index and flatten
  const sortedEntries = layoutFieldNames
    .map((name) => ({ name, index: layout.fields[name].index }))
    .sort((a, b) => a.index - b.index);

  const result: Fr[] = [];
  for (const entry of sortedEntries) {
    const value = values[entry.name];
    if (Array.isArray(value)) {
      result.push(...value);
    } else {
      result.push(value);
    }
  }

  // Validate total length matches layout
  if (result.length !== layout.serializedLen) {
    throw new Error(
      `Serialized length mismatch: got ${result.length} Fr elements, expected ${layout.serializedLen} (from #[abi(immutables)] layout)`,
    );
  }

  return result;
}

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
 * @returns The contract address and capsuleData for backup/capsule creation
 */
export async function computeImmutablesAddress(
  artifact: ContractArtifact,
  serializedImmutables: Fr[],
  options?: ImmutablesInstanceOptions,
): Promise<{ address: AztecAddress; capsuleData: Fr[] }> {
  const { instance, actualSalt } = await createImmutablesInstance(
    artifact,
    serializedImmutables,
    options,
  );
  return {
    address: instance.address,
    capsuleData: [actualSalt, ...serializedImmutables],
  };
}

// ---------------------------------------------------------------------------
// Full deployment (register + optionally publish)
// ---------------------------------------------------------------------------

/**
 * Result of deploying a contract with immutables
 */
export interface DeployWithImmutablesResult {
  instance: ContractInstanceWithAddress;
  /**
   * The full capsule data array: `[actualSalt, ...serializedImmutables]`.
   * Persist this externally for backup — it contains everything needed to
   * re-store immutables on a new PXE via `store_immutables(capsuleData).simulate()`.
   *
   * - `capsuleData[0]` is the `actualSalt` (random nonce for address uniqueness)
   * - `capsuleData[1..]` are the serialized immutable fields
   */
  capsuleData: Fr[];
}

/**
 * Options for deploying a contract with immutables
 */
export interface DeployWithImmutablesOptions extends ImmutablesInstanceOptions {
  /** Publish the contract class on-chain (default: `false`). */
  publishClass?: boolean;
  /** Publish the contract instance on-chain (default: `false`). Private execution works without publication. */
  publishInstance?: boolean;
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

  // Validate serialized immutables against the #[abi(immutables)] layout in the artifact.
  // Uses serialized_len (not field count) since nested structs flatten to multiple Fr elements.
  const layout = getImmutablesLayout(artifact);
  if (layout && serializedImmutables.length !== layout.serializedLen) {
    const fieldNames = Object.keys(layout.fields).join(", ");
    throw new Error(
      `Immutables serialized length mismatch: expected ${layout.serializedLen} Fr elements for fields (${fieldNames}), got ${serializedImmutables.length}`,
    );
  }

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

  if (options?.publishInstance) {
    // Create capsule with [actual_salt, ...serialized_immutables]
    const capsule = createImmutablesCapsule(
      instance.address,
      actualSalt,
      serializedImmutables,
    );

    // Build execution payloads and merge into a single atomic transaction
    // (mirrors how DeployMethod merges class + instance publication)
    const payloads: ExecutionPayload[] = [];

    // Publish the contract class if requested
    if (options?.publishClass) {
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

  return { instance, capsuleData };
}
