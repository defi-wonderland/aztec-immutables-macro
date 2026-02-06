/**
 * E2E Test: Initializerless Account with Dripper FPC
 *
 * This test validates the initializerless constants pattern by demonstrating
 * that a SchnorrConstantsAccount (no initializer, key committed in address)
 * can successfully receive private token transfers via the Dripper faucet.
 *
 * ## Problem Being Solved
 *
 * When creating a new account in Aztec:
 * - Traditional accounts require initialization which creates an init nullifier
 * - The account being created has no fee juice to pay for initialization
 * - This creates a chicken-and-egg problem for account bootstrapping
 *
 * ## Solution
 *
 * The initializerless constants pattern:
 * - No initialization method required
 * - Key is committed to the contract address via salt
 * - No on-chain tx required to "initialize" the account
 * - Account can immediately receive tokens and transact
 *
 * ## Test Flow
 *
 * 1. Deploy Dripper contract (faucet)
 * 2. Deploy Token contract with Dripper as minter
 * 3. Deploy SchnorrConstantsAccount (initializerless)
 * 4. Deploy standard SchnorrAccount for comparison
 * 5. Use drip_to_private from both accounts
 * 6. Verify both accounts received tokens
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { getContractInstanceFromInstantiationParams } from "@aztec/aztec.js/contracts";
import { SponsoredFPCContract } from "@aztec/noir-contracts.js/SponsoredFPC";
import type { Wallet } from "@aztec/aztec.js/wallet";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import { setupTestSuite } from "./utils.js";

/**
 * Register the canonical SponsoredFPC contract and return its address.
 * The SponsoredFPC is deployed at a well-known address using salt = 0.
 */
async function registerDeployedSponsoredFPCInWalletAndGetAddress(
  wallet: Wallet,
): Promise<AztecAddress> {
  // SPONSORED_FPC_SALT = 0 in @aztec/constants
  const SPONSORED_FPC_SALT = 0n;
  const instance = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContract.artifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  // Register (no-op if already registered)
  await wallet.registerContract(instance, SponsoredFPCContract.artifact);
  return instance.address;
}

import {
  registerConstantsAccount,
  createSigningKeyCapsule,
} from "./schnorr-constants-account/wallet-integration.js";
import { deploySchnorrAccount } from "./schnorr-account/utils.js";

// Import Token and Dripper from aztec-standards
// Note: Path goes up from src/ts/ to workspace root, then to aztec-standards
import { TokenContract } from "../../src/artifacts/Token.js";
import { DripperContract } from "../../src/artifacts/Dripper.js";

describe("Initializerless Account with Dripper FPC", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let deployerAddress: AztecAddress;

  // Contracts
  let token: TokenContract;
  let dripper: DripperContract;

  // Fee sponsorship - allows accounts without fee juice to transact
  let sponsoredFPCAddress: AztecAddress;
  let sponsoredPaymentMethod: SponsoredFeePaymentMethod;

  // Test configuration
  const DRIP_AMOUNT = 1000n; // Amount to drip to each account

  beforeAll(async () => {
    // Use unique suffix to avoid state conflicts between test runs
    const suffix = `initializerless-dripper-${Date.now()}`;
    ({
      store,
      wallet,
      accounts: [deployerAddress],
    } = await setupTestSuite(suffix));

    // Register the canonical SponsoredFPC for fee sponsorship
    // This allows accounts without fee juice to send transactions
    console.log("Registering SponsoredFPC...");
    sponsoredFPCAddress =
      await registerDeployedSponsoredFPCInWalletAndGetAddress(wallet);
    sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCAddress);
    console.log(`SponsoredFPC registered at: ${sponsoredFPCAddress}`);

    // Deploy Dripper contract (faucet)
    console.log("Deploying Dripper contract...");
    dripper = await DripperContract.deploy(wallet).send({
      from: deployerAddress,
    });
    console.log(`Dripper deployed at: ${dripper.address}`);

    // Deploy Token contract with Dripper as minter
    console.log("Deploying Token contract with Dripper as minter...");
    token = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "TestToken", // name
      "TST", // symbol
      18n, // decimals
      dripper.address, // minter = Dripper contract
      AztecAddress.ZERO, // upgrade_authority (not upgradeable)
    ).send({ from: deployerAddress });
    console.log(`Token deployed at: ${token.address}`);
  });

  afterAll(async () => {
    await store.delete();
  });

  it("should drip to private balance of initializerless account", async () => {
    // Deploy SchnorrConstantsAccount (initializerless pattern)
    console.log("Deploying SchnorrConstantsAccount (initializerless)...");
    const constantsAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });
    console.log(
      `SchnorrConstantsAccount deployed at: ${constantsAccount.address}`,
    );

    // Call drip_to_private from the constants account
    // This proves the account can:
    // 1. Sign transactions (AuthWitness provider works)
    // 2. Be identified as msg_sender by the Dripper
    // 3. Receive private token notes
    console.log("Calling drip_to_private from constants account...");

    // IMPORTANT: The SchnorrConstantsAccount needs its capsule for EVERY transaction
    // because the entrypoint calls `valid_fn` which reads the signing key via capsules::load()
    const capsule = createSigningKeyCapsule(
      constantsAccount.address,
      constantsAccount.actualSalt,
      constantsAccount.signingPublicKey,
    );

    const tx = await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .with({ capsules: [capsule] })
      .send({
        from: constantsAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });
    expect(tx.isMined()).toBe(true);
    console.log(
      `drip_to_private succeeded for constants account, tx: ${tx.txHash}`,
    );

    // Check private balance using unconstrained function
    // Note: balance_of_private is an unconstrained function that reads from PXE state
    const balance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });

    expect(balance).toEqual(DRIP_AMOUNT);
    console.log(`Constants account private balance: ${balance}`);
  });

  it("should drip to private balance of standard schnorr account", async () => {
    // Deploy standard SchnorrAccount for comparison
    console.log("Deploying standard SchnorrAccount...");
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });
    console.log(
      `Standard SchnorrAccount deployed at: ${standardAccount.contract.address}`,
    );

    // Call drip_to_private from the standard account
    console.log("Calling drip_to_private from standard account...");
    const tx = await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .send({
        from: standardAccount.contract.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);
    console.log(
      `drip_to_private succeeded for standard account, tx: ${tx.txHash}`,
    );

    // Check private balance
    const balance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });

    expect(balance).toEqual(DRIP_AMOUNT);
    console.log(`Standard account private balance: ${balance}`);
  });

  it("should demonstrate both accounts working side by side with transfers", async () => {
    // Deploy both account types
    const constantsAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });

    console.log(`Constants account: ${constantsAccount.address}`);
    console.log(`Standard account: ${standardAccount.contract.address}`);

    // Create capsule for the constants account (needed for every transaction)
    const capsule = createSigningKeyCapsule(
      constantsAccount.address,
      constantsAccount.actualSalt,
      constantsAccount.signingPublicKey,
    );

    // Drip to both accounts in sequence - each gets DRIP_AMOUNT (1000)
    console.log("Dripping tokens to both accounts...");
    const constantsDripTx = await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .with({ capsules: [capsule] })
      .send({
        from: constantsAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    const standardDripTx = await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .send({
        from: standardAccount.contract.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(constantsDripTx.isMined()).toBe(true);
    expect(standardDripTx.isMined()).toBe(true);
    console.log("Both accounts received initial tokens");

    // Transfer amounts
    const TRANSFER_TO_STANDARD = 100n;
    const TRANSFER_TO_PUBLIC = 100n;
    const TRANSFER_TO_CONSTANTS = 50n;

    // 1. ConstantsAccount transfers 100 private tokens to StandardAccount
    console.log("ConstantsAccount -> StandardAccount: 100 private...");
    const tx1 = await token.methods
      .transfer_private_to_private(
        constantsAccount.address, // from
        standardAccount.contract.address, // to
        TRANSFER_TO_STANDARD, // amount
        0n, // nonce (0 when sender is caller)
      )
      .with({ capsules: [capsule] })
      .send({
        from: constantsAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });
    expect(tx1.isMined()).toBe(true);

    // 2. ConstantsAccount transfers 100 private tokens to self as public
    console.log("ConstantsAccount: 100 private -> public...");
    const tx2 = await token.methods
      .transfer_private_to_public(
        constantsAccount.address, // from
        constantsAccount.address, // to (self)
        TRANSFER_TO_PUBLIC, // amount
        0n, // nonce
      )
      .with({ capsules: [capsule] })
      .send({
        from: constantsAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });
    expect(tx2.isMined()).toBe(true);

    // 3. StandardAccount transfers 50 private tokens to ConstantsAccount
    console.log("StandardAccount -> ConstantsAccount: 50 private...");
    const tx3 = await token.methods
      .transfer_private_to_private(
        standardAccount.contract.address, // from
        constantsAccount.address, // to
        TRANSFER_TO_CONSTANTS, // amount
        0n, // nonce
      )
      .send({
        from: standardAccount.contract.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });
    expect(tx3.isMined()).toBe(true);

    // Verify final balances
    // ConstantsAccount: 1000 - 100 (to standard) - 100 (to public) + 50 (from standard) = 850 private, 100 public
    // StandardAccount: 1000 + 100 (from constants) - 50 (to constants) = 1050 private, 0 public
    const expectedConstantsPrivate =
      DRIP_AMOUNT -
      TRANSFER_TO_STANDARD -
      TRANSFER_TO_PUBLIC +
      TRANSFER_TO_CONSTANTS;
    const expectedConstantsPublic = TRANSFER_TO_PUBLIC;
    const expectedStandardPrivate =
      DRIP_AMOUNT + TRANSFER_TO_STANDARD - TRANSFER_TO_CONSTANTS;
    const expectedStandardPublic = 0n;

    const constantsPrivateBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });

    const constantsPublicBalance = await token.methods
      .balance_of_public(constantsAccount.address)
      .simulate({ from: deployerAddress });

    const standardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });

    const standardPublicBalance = await token.methods
      .balance_of_public(standardAccount.contract.address)
      .simulate({ from: deployerAddress });

    console.log("\nFinal balances:");
    console.log(
      `  Constants account private: ${constantsPrivateBalance} (expected: ${expectedConstantsPrivate})`,
    );
    console.log(
      `  Constants account public:  ${constantsPublicBalance} (expected: ${expectedConstantsPublic})`,
    );
    console.log(
      `  Standard account private:  ${standardPrivateBalance} (expected: ${expectedStandardPrivate})`,
    );
    console.log(
      `  Standard account public:   ${standardPublicBalance} (expected: ${expectedStandardPublic})`,
    );

    expect(constantsPrivateBalance).toEqual(expectedConstantsPrivate);
    expect(constantsPublicBalance).toEqual(expectedConstantsPublic);
    expect(standardPrivateBalance).toEqual(expectedStandardPrivate);
    expect(standardPublicBalance).toEqual(expectedStandardPublic);

    console.log("\nAll transfers completed successfully!");
  });

  it("should verify contract metadata for published vs unpublished accounts", async () => {
    // Deploy a published account (default behavior)
    console.log("Deploying published account...");
    const publishedAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });
    console.log(`Published account: ${publishedAccount.address}`);
    expect(publishedAccount.isPublished).toBe(true);

    // Deploy an unpublished account (PXE-only)
    console.log("Deploying unpublished account (PXE-only)...");
    const unpublishedAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
      skipInstancePublication: true,
    });
    console.log(`Unpublished account: ${unpublishedAccount.address}`);
    expect(unpublishedAccount.isPublished).toBe(false);

    // Check contract metadata for published account
    const publishedMetadata = await wallet.getContractMetadata(
      publishedAccount.address,
    );
    console.log("\nPublished account metadata:");
    console.log(
      `  isContractPublished: ${publishedMetadata.isContractPublished}`,
    );
    console.log(
      `  isContractInitialized: ${publishedMetadata.isContractInitialized}`,
    );

    expect(publishedMetadata.isContractPublished).toBe(true);
    expect(publishedMetadata.isContractInitialized).toBe(false); // No initializer!

    // Check contract metadata for unpublished account
    const unpublishedMetadata = await wallet.getContractMetadata(
      unpublishedAccount.address,
    );
    console.log("\nUnpublished account metadata:");
    console.log(
      `  isContractPublished: ${unpublishedMetadata.isContractPublished}`,
    );
    console.log(
      `  isContractInitialized: ${unpublishedMetadata.isContractInitialized}`,
    );

    expect(unpublishedMetadata.isContractPublished).toBe(false);
    expect(unpublishedMetadata.isContractInitialized).toBe(false);

    console.log("\nMetadata verification complete!");
  });

  it("should allow unpublished account to send private transactions", async () => {
    /**
     * This test validates that an account contract with only private functions
     * can work WITHOUT on-chain publication.
     *
     * Key insight: The private kernel validates against local hints, not on-chain state.
     * Since SchnorrConstantsAccount has only private functions:
     * - entrypoint (private)
     * - verify_private_authwit (private)
     * - lookup_validity (utility)
     *
     * It can operate entirely within private execution, requiring only PXE registration.
     */
    console.log("Deploying unpublished account (PXE-only)...");
    const unpublishedAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
      skipInstancePublication: true,
    });
    console.log(`Unpublished account: ${unpublishedAccount.address}`);
    expect(unpublishedAccount.isPublished).toBe(false);

    // Verify it's truly unpublished
    const metadata = await wallet.getContractMetadata(
      unpublishedAccount.address,
    );
    expect(metadata.isContractPublished).toBe(false);
    console.log("Confirmed: account is NOT published on-chain");

    // Create capsule for the account (needed for every transaction)
    const capsule = createSigningKeyCapsule(
      unpublishedAccount.address,
      unpublishedAccount.actualSalt,
      unpublishedAccount.signingPublicKey,
    );

    // Try to send a transaction from the unpublished account
    console.log("Attempting drip_to_private from unpublished account...");
    const tx = await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .with({ capsules: [capsule] })
      .send({
        from: unpublishedAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);
    console.log(`Transaction succeeded! tx: ${tx.txHash}`);

    // Verify tokens were received
    const balance = await token.methods
      .balance_of_private(unpublishedAccount.address)
      .simulate({ from: deployerAddress });

    expect(balance).toEqual(DRIP_AMOUNT);
    console.log(`Unpublished account private balance: ${balance}`);

    console.log(
      "\n✓ Unpublished account successfully sent private transaction!",
    );
    console.log(
      "  This proves: private-only accounts don't require on-chain publication.",
    );
  });
});
