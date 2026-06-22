/**
 * SchnorrAccount Deployment Utilities (Standard Pattern)
 *
 * This module provides utilities for deploying and interacting with the
 * standard SchnorrAccount contract, which uses an initializer to store
 * the signing public key in SinglePrivateImmutable storage.
 *
 * ## Comparison with SchnorrInitializerlessAccount
 *
 * | Feature | This Contract | SchnorrInitializerlessAccount |
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
 * const { contract, secretKey } = await deploySchnorrAccount(wallet, { secretKey: Fr.random() });
 *
 * // The signing key is derived from the secret key
 * ```
 */

import { Fr } from "@aztec/aztec.js/fields";
import { NO_FROM } from "@aztec/aztec.js/account";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { deriveSigningKey } from "@aztec/stdlib/keys";
import { Schnorr } from "@aztec/foundation/crypto/schnorr";
import type { EmbeddedWallet } from "@aztec/wallets/embedded";
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
 * This uses the proper account deployment pattern via EmbeddedWallet.createSchnorrAccount():
 * 1. Creates account with secret key (uses the default SchnorrAccountContract)
 * 2. Registers the account with PXE (including public keys for encryption)
 * 3. Deploys and initializes the contract
 * 4. Note delivery is handled automatically via MessageDelivery.CONSTRAINED_ONCHAIN
 *
 * Note: This uses the SDK's SchnorrAccountContract from @aztec/accounts which has
 * a different class ID than our local contract. For benchmarking the local contract,
 * we need to use a different approach.
 *
 * @param wallet - The wallet to deploy with (must be an EmbeddedWallet)
 * @param options - Optional deployment options
 * @returns The deployed contract instance and keys
 */
export async function deploySchnorrAccount(
  wallet: Wallet,
  options?: {
    secretKey?: Fr;
    salt?: Fr;
    fee?: { paymentMethod: any };
  },
): Promise<DeploySchnorrAccountResult> {
  // Generate or use provided secret key
  const secretKey = options?.secretKey ?? Fr.random();
  const salt = options?.salt ?? Fr.random();

  // Derive signing public key from secret via scalar multiplication
  const signingPrivateKey = deriveSigningKey(secretKey);
  const schnorr = new Schnorr();
  const publicKeyPoint = await schnorr.computePublicKey(signingPrivateKey);
  const signingPublicKey: SigningPublicKey = {
    x: new Fr(publicKeyPoint.x.toBigInt()),
    y: new Fr(publicKeyPoint.y.toBigInt()),
  };

  // Use EmbeddedWallet.createSchnorrAccount which uses the SDK's SchnorrAccountContract
  // This handles all the auth witness provider setup properly
  const embeddedWallet = wallet as unknown as EmbeddedWallet;
  const accountManager = await embeddedWallet.createSchnorrAccount(
    secretKey,
    salt,
  );

  // Self-deployment: use NO_FROM to bypass account contract mediation.
  // The account contract doesn't exist yet, so it cannot sign its own deployment tx.
  const deployMethod = await accountManager.getDeployMethod();
  await deployMethod.send({ from: NO_FROM, fee: options?.fee });

  // Get the deployed contract instance using our local artifact
  // Note: This will have the same address but uses our local artifact
  const contract = SchnorrAccountContract.at(accountManager.address, wallet);

  return {
    contract,
    secretKey,
    signingPublicKey,
  };
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
 * @param deployer - The account address that pays fees and sends the deploy transaction
 * @param options - Optional deployment options
 * @returns The deployed contract instance and keys
 */
export async function deployLocalSchnorrAccount(
  wallet: Wallet,
  deployer: AztecAddress,
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

  // Deploy our local SchnorrAccount contract with the initializer
  const { contract } = await SchnorrAccountContract.deploy(
    wallet,
    signingPublicKey.x,
    signingPublicKey.y,
  ).send({ from: deployer });

  return {
    contract,
    signingPublicKey,
  };
}
