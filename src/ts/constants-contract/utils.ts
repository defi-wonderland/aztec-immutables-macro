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
import type { Wallet } from "@aztec/aztec.js/wallet";
import {
  ConstantsContractContract,
  ConstantsContractContractArtifact,
} from "../../artifacts/ConstantsContract.js";
import {
  publishContractClass,
  publishInstance,
} from "@aztec/aztec.js/deployment";

/**
 * Constants slot - must match CONSTANTS_SLOT in the #[constants] macro
 * Computed as: poseidon2_hash_bytes("CONSTANTS_SLOT".as_bytes())
 */
export const CONSTANTS_SLOT = new Fr(
  0x257f7fa8d0b607b4f584f2aa6480ae86716203481e2802444cf05a289cc85b3an,
);

/**
 * Constants type matching the Noir struct
 */
export interface Constants {
  signingKeyX: Fr;
  signingKeyY: Fr;
}

/**
 * Serializes Constants to Fr array (matches Noir serialization order)
 */
export function serializeConstants(constants: Constants): Fr[] {
  return [constants.signingKeyX, constants.signingKeyY];
}

/**
 * Computes the contract salt from actual_salt and constants.
 * This must match the Noir: poseidon2_hash([actual_salt, ...serialized_constants])
 *
 * @param actualSalt - The random salt value stored in the capsule
 * @param constants - The constants to commit
 * @returns The derived salt to use in the contract instance
 */
export async function computeContractSalt(
  actualSalt: Fr,
  constants: Constants,
): Promise<Fr> {
  const capsuleData = [actualSalt, ...serializeConstants(constants)];
  const result = await poseidon2Hash(capsuleData as any);
  return new Fr(result.toBigInt());
}

/**
 * Computes the initialization hash from constants (for compatibility/testing)
 * @deprecated Use computeContractSalt instead for salt-based verification
 */
export async function computeConstantsHash(constants: Constants): Promise<Fr> {
  const serialized = serializeConstants(constants);
  return poseidon2Hash(serialized);
}

/**
 * Creates a Capsule containing the actual_salt and constants for a given contract address.
 * Capsule format: [actual_salt, ...serialized_constants]
 *
 * @param contractAddress - The contract address to create the capsule for
 * @param actualSalt - The random salt value used during deployment
 * @param constants - The constants values
 */
export function createConstantsCapsule(
  contractAddress: AztecAddress,
  actualSalt: Fr,
  constants: Constants,
): Capsule {
  const data = [actualSalt, ...serializeConstants(constants)];
  return new Capsule(contractAddress, CONSTANTS_SLOT, data);
}

/**
 * Result of deploying the constants contract
 */
export interface DeployConstantsContractResult {
  contract: ConstantsContractContract;
  /** The random salt stored in capsule, needed for creating capsules later */
  actualSalt: Fr;
}

/**
 * Creates a contract instance with salt derived from actual_salt and constants.
 *
 * The contract's salt field = poseidon2_hash([actual_salt, ...serialized_constants])
 * This allows verification at runtime by hashing the capsule data.
 *
 * @param constants - The constants to commit
 * @param options - Optional deployment options (actualSalt, publicKeys, deployer)
 * @returns The contract instance with address and the actual_salt for capsule creation
 */
export async function createConstantsInstance(
  constants: Constants,
  options?: {
    /** Random salt stored in capsule (generated if not provided) */
    actualSalt?: Fr;
    publicKeys?: PublicKeys;
    deployer?: AztecAddress;
  },
): Promise<{ instance: ContractInstanceWithAddress; actualSalt: Fr }> {
  const actualSalt = options?.actualSalt ?? Fr.random();
  const publicKeys = options?.publicKeys ?? PublicKeys.default();
  const deployer = options?.deployer ?? AztecAddress.ZERO;

  const contractClass = await getContractClassFromArtifact(
    ConstantsContractContractArtifact,
  );

  // Compute salt = poseidon2Hash([actual_salt, ...serialized_constants])
  const salt = await computeContractSalt(actualSalt, constants);

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
 * Deploys the ConstantsContract with the given constants using the initializerless pattern.
 *
 * This handles the initializerless deployment pattern:
 * 1. Generates random actual_salt
 * 2. Computes salt = poseidon2Hash([actual_salt, ...serialized_constants])
 * 3. Creates contract instance with this salt
 * 4. Registers and publishes the contract
 * 5. Sends capsule containing [actual_salt, ...serialized_constants]
 *
 * @param wallet - The wallet to deploy with
 * @param constants - The constants to commit to the contract address
 * @param options - Optional deployment options (actualSalt, deployer)
 * @returns The deployed contract and actual_salt for capsule creation
 */
export async function deployConstantsContract(
  wallet: Wallet,
  constants: Constants,
  options?: {
    actualSalt?: Fr;
    deployer?: AztecAddress;
    skipClassPublication?: boolean;
  },
): Promise<DeployConstantsContractResult> {
  const deployerAddress = (await wallet.getAccounts())[0]!.item;
  const deployer = options?.deployer ?? AztecAddress.ZERO;

  // Create contract instance with constants committed via salt
  const { instance, actualSalt } = await createConstantsInstance(constants, {
    actualSalt: options?.actualSalt,
    deployer,
  });

  // Create capsule with [actual_salt, ...serialized_constants]
  const capsule = createConstantsCapsule(
    instance.address,
    actualSalt,
    constants,
  );

  // Register the contract with the wallet
  await wallet.registerContract(instance, ConstantsContractContractArtifact);

  // Publish the contract class if not skipped
  if (!options?.skipClassPublication) {
    const contractClass = await getContractClassFromArtifact(
      ConstantsContractContractArtifact,
    );
    const metadata = await wallet.getContractClassMetadata(contractClass.id);

    if (!metadata.isContractClassPubliclyRegistered) {
      const publishClassInteraction = await publishContractClass(
        wallet,
        ConstantsContractContractArtifact,
      );
      await publishClassInteraction.send({ from: deployerAddress }).wait();
    }
  }

  // Publish the contract instance with capsule
  const publishInstanceInteraction = await publishInstance(wallet, instance);
  await publishInstanceInteraction
    .with({ capsules: [capsule] })
    .send({ from: deployerAddress })
    .wait();

  const contract = ConstantsContractContract.at(instance.address, wallet);
  return { contract, actualSalt };
}

/**
 * Deploys the ConstantsContract using the standard initializer pattern.
 *
 * This is for mixed usage scenarios where:
 * - The contract has both constants AND mutable storage
 * - The initializer sets up storage
 * - Constants are passed via capsule
 *
 * Note: This deployment computes initialization_hash from the initializer args only,
 * NOT including the constants. This means constants verification will fail.
 * For production mixed usage, a custom deployment that includes
 * both initializer args AND constants in the salt computation would be needed.
 *
 * @param wallet - The wallet to deploy with
 * @param constants - The constants to pass via capsule
 * @param initialCounter - The initial counter value for storage
 * @returns The deployed contract and actual_salt for capsule creation
 */
export async function deployMixedUsageContract(
  wallet: Wallet,
  constants: Constants,
  initialCounter: bigint,
): Promise<DeployConstantsContractResult> {
  const deployerAddress = (await wallet.getAccounts())[0]!.item;
  const actualSalt = Fr.random();

  // Deploy using standard method with initializer
  const deployMethod = ConstantsContractContract.deploy(wallet, initialCounter);

  // Get the deployment address before sending to create capsule
  const instance = await deployMethod.getInstance();
  const capsule = createConstantsCapsule(
    instance.address,
    actualSalt,
    constants,
  );

  // Deploy with capsule attached
  const tx = deployMethod.send({
    capsules: [capsule],
    from: deployerAddress,
  });
  const contract = await tx.deployed();

  return { contract, actualSalt };
}
