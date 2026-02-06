/**
 * SchnorrAccount Deployment Utilities (Standard Pattern)
 *
 * This module provides utilities for deploying and interacting with the
 * standard SchnorrAccount contract, which uses an initializer to store
 * the signing public key in SinglePrivateImmutable storage.
 *
 * ## Comparison with SchnorrConstantsAccount
 *
 * | Feature | This Contract | SchnorrConstantsAccount |
 * |---------|---------------|------------------------|
 * | Storage | SinglePrivateImmutable | Capsule storage |
 * | Initializer | Required (constructor) | Not required |
 * | Deployment | Needs initializer tx + note delivery | Direct deployment |
 * | Key binding | Stored in private state tree | Committed in contract address |
 *
 * ## Usage
 *
 * ```typescript
 * // Deploy the account contract using the proper account deployment flow
 * const { contract, secretKey } = await deploySchnorrAccount(wallet);
 *
 * // The signing key is derived from the secret key
 * ```
 */

import { Fr } from "@aztec/aztec.js/fields";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { AccountManager } from "@aztec/aztec.js/wallet";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import {
  SchnorrAccountContract,
  SchnorrAccountContractArtifact,
} from "../../artifacts/SchnorrAccount.js";

/**
 * Signing public key type (Grumpkin curve point coordinates)
 */
export interface SigningPublicKey {
  x: Fr;
  y: Fr;
}

/**
 * Result of deploying a SchnorrAccount
 */
export interface DeploySchnorrAccountResult {
  contract: SchnorrAccountContract;
  secretKey: Fr;
  signingPublicKey: SigningPublicKey;
}

/**
 * Deploys the standard SchnorrAccount contract.
 *
 * This uses the proper account deployment pattern via TestWallet.createAccount():
 * 1. Creates account with secret key (uses the default SchnorrAccountContract)
 * 2. Registers the account with PXE (including public keys for encryption)
 * 3. Deploys and initializes the contract
 * 4. Note delivery is handled automatically via MessageDelivery.CONSTRAINED_ONCHAIN
 *
 * Note: This uses the SDK's SchnorrAccountContract from @aztec/accounts which has
 * a different class ID than our local contract. For benchmarking the local contract,
 * we need to use a different approach.
 *
 * @param wallet - The wallet to deploy with (must be a TestWallet)
 * @param options - Optional deployment options
 * @returns The deployed contract instance and keys
 */
export async function deploySchnorrAccount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wallet: Wallet & { createAccount?: (data?: any) => Promise<AccountManager> },
  options?: {
    secretKey?: Fr;
    salt?: Fr;
  },
): Promise<DeploySchnorrAccountResult> {
  // Generate or use provided secret key
  const secretKey = options?.secretKey ?? Fr.random();
  const salt = options?.salt ?? Fr.random();

  // Derive signing key from secret to get the public key
  const signingKey = deriveSigningKey(secretKey);
  const signingPublicKey: SigningPublicKey = {
    x: new Fr(signingKey.lo),
    y: new Fr(signingKey.hi),
  };

  // Use TestWallet.createAccount which uses the SDK's SchnorrAccountContract
  // This handles all the auth witness provider setup properly
  if (wallet.createAccount) {
    const accountManager = await wallet.createAccount({
      secret: secretKey,
      salt,
      // Don't pass contract - let it use the default SchnorrAccountContract
    });

    // Get the deployer address (first registered account)
    const deployerAddress = (await wallet.getAccounts())[0]!.item;

    // Deploy the account contract
    const deployMethod = await accountManager.getDeployMethod();
    await deployMethod.send({ from: deployerAddress });

    // Get the deployed contract instance using our local artifact
    // Note: This will have the same address but uses our local artifact
    const contract = SchnorrAccountContract.at(accountManager.address, wallet);

    return {
      contract,
      secretKey,
      signingPublicKey,
    };
  }

  throw new Error(
    "deploySchnorrAccount requires a TestWallet with createAccount method",
  );
}

/**
 * Export the artifact for direct access if needed
 */
export { SchnorrAccountContract, SchnorrAccountContractArtifact };

/**
 * Deploys our local SchnorrAccount contract directly (not the SDK's).
 *
 * This is needed for benchmarking because our local contract has `get_signing_public_key()`
 * which the SDK's SchnorrAccountContract does not expose.
 *
 * Note: This deploys a standard contract, not a functional account wallet.
 * The contract cannot be used for signing transactions - it's only for benchmarking
 * the key storage/retrieval pattern.
 *
 * @param wallet - The wallet to deploy with
 * @param options - Optional deployment options
 * @returns The deployed contract instance and keys
 */
export async function deployLocalSchnorrAccount(
  wallet: Wallet,
  options?: {
    signingPublicKey?: SigningPublicKey;
    salt?: Fr;
  },
): Promise<{
  contract: SchnorrAccountContract;
  signingPublicKey: SigningPublicKey;
}> {
  // Use provided signing key or generate arbitrary values for benchmarking
  const signingPublicKey = options?.signingPublicKey ?? {
    x: new Fr(0xdeadbeefcafebabe1234n),
    y: new Fr(0xfeedface5678abcdn),
  };

  // Get the deployer address (first registered account)
  const deployerAddress = (await wallet.getAccounts())[0]!.item;

  // Deploy our local SchnorrAccount contract with the initializer
  const contract = await SchnorrAccountContract.deploy(
    wallet,
    signingPublicKey.x,
    signingPublicKey.y,
  ).send({ from: deployerAddress });

  return {
    contract,
    signingPublicKey,
  };
}
