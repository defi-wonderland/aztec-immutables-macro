/**
 * E2E Test: Initializerless Account
 *
 * This test validates the initializerless immutables pattern by demonstrating
 * that a SchnorrInitializerlessAccount (no initializer, key committed in address)
 * can successfully receive and transfer private tokens.
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
 * The initializerless immutables pattern:
 * - No initialization method required
 * - Key is committed to the contract address via salt
 * - No on-chain tx required to "initialize" the account
 * - Account can immediately receive tokens and transact
 *
 * ## Test Flow
 *
 * 1. Deploy Token contract with deployer as minter
 * 2. Deploy SchnorrInitializerlessAccount
 * 3. Deploy standard SchnorrAccount for comparison
 * 4. Mint tokens to accounts, verify transfers work
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

import { deploySchnorrInitializerlessAccount } from "./schnorr-initializerless-account/index.js";
import { deploySchnorrAccount } from "./schnorr-account/utils.js";

/**
 * Deploys a SchnorrInitializerlessAccount and registers it with TestWallet for signing.
 * This is a test-only helper — production wallets handle account registration differently.
 */
async function deployAndRegister(
  wallet: TestWallet,
  options?: Parameters<typeof deploySchnorrInitializerlessAccount>[1],
) {
  const result = await deploySchnorrInitializerlessAccount(wallet, options);
  // @ts-ignore — TestWallet-specific: register account for signing
  wallet.accounts?.set(result.address.toString(), result.account);
  return result;
}

// Import Token from aztec-standards
import { TokenContract } from "../../src/artifacts/Token.js";

describe("Initializerless Account", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let deployerAddress: AztecAddress;

  // Contracts
  let token: TokenContract;

  // Fee sponsorship - allows accounts without fee juice to transact
  let sponsoredFPCAddress: AztecAddress;
  let sponsoredPaymentMethod: SponsoredFeePaymentMethod;

  // Test configuration
  const MINT_AMOUNT = 1000n;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [deployerAddress],
    } = await setupTestSuite("initializerless-account"));

    // Register the canonical SponsoredFPC for fee sponsorship
    // This allows accounts without fee juice to send transactions
    sponsoredFPCAddress =
      await registerDeployedSponsoredFPCInWalletAndGetAddress(wallet);
    sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCAddress);

    // Deploy Token contract with deployer as minter
    token = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "TestToken", // name
      "TST", // symbol
      18n, // decimals
      deployerAddress, // minter = deployer
      AztecAddress.ZERO, // upgrade_authority (not upgradeable)
    ).send({ from: deployerAddress });
  });

  afterAll(async () => {
    await store.delete();
  });

  it("should mint to private balance of initializerless account", async () => {
    // Deploy SchnorrInitializerlessAccount
    const initializerlessAccount = await deployAndRegister(wallet, {
      secretKey: Fr.random(),
    });

    const initialBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });
    expect(initialBalance).toEqual(0n);

    // Deployer mints tokens to the initializerless account
    await token.methods
      .mint_to_private(initializerlessAccount.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const finalBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });

    expect(finalBalance).toEqual(MINT_AMOUNT);
  });

  it("should mint to private balance of standard schnorr account", async () => {
    // Deploy standard SchnorrAccount for comparison
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });

    const initialBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(initialBalance).toEqual(0n);

    // Deployer mints tokens to the standard account
    await token.methods
      .mint_to_private(standardAccount.contract.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    // Check private balance
    const finalBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });

    expect(finalBalance).toEqual(MINT_AMOUNT);
  });

  it("should allow unpublished account to send private transactions", async () => {
    const unpublishedAccount = await deployAndRegister(wallet, {
      secretKey: Fr.random(),
    });

    // Verify it's truly unpublished
    const metadata = await wallet.getContractMetadata(
      unpublishedAccount.address,
    );
    expect(metadata.isContractPublished).toBe(false);

    // Deployer mints tokens to the unpublished account
    await token.methods
      .mint_to_private(unpublishedAccount.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const privateBalance = await token.methods
      .balance_of_private(unpublishedAccount.address)
      .simulate({ from: deployerAddress });
    expect(privateBalance).toEqual(MINT_AMOUNT);

    // Unpublished account sends a private transfer — proves it can transact
    // Immutables loaded from persistent store (store_immutables called during deployment)
    const tx = await token.methods
      .transfer_private_to_private(
        unpublishedAccount.address,
        deployerAddress,
        MINT_AMOUNT,
        0n,
      )
      .send({
        from: unpublishedAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);

    // Verify tokens were transferred
    const finalBalance = await token.methods
      .balance_of_private(unpublishedAccount.address)
      .simulate({ from: deployerAddress });

    expect(finalBalance).toEqual(0n);
  });

  it("should allow unpublished account to send public transactions", async () => {
    const unpublishedAccount = await deployAndRegister(wallet, {
      secretKey: Fr.random(),
    });

    // Verify it's truly unpublished
    const metadata = await wallet.getContractMetadata(
      unpublishedAccount.address,
    );
    expect(metadata.isContractPublished).toBe(false);

    // Deployer mints tokens to the unpublished account's private balance
    await token.methods
      .mint_to_private(unpublishedAccount.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    // transfer_private_to_public enqueues a public call — proves the unpublished account
    // can send public transactions, not just private ones
    const tx = await token.methods
      .transfer_private_to_public(
        unpublishedAccount.address,
        unpublishedAccount.address,
        MINT_AMOUNT,
        0n,
      )
      .send({
        from: unpublishedAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);

    const publicBalance = await token.methods
      .balance_of_public(unpublishedAccount.address)
      .simulate({ from: deployerAddress });

    expect(publicBalance).toEqual(MINT_AMOUNT);
  });

  it("should demonstrate both accounts working side by side with transfers", async () => {
    // Deploy both account types
    const initializerlessAccount = await deployAndRegister(wallet, {
      secretKey: Fr.random(),
    });
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });

    // Deployer mints to both accounts
    await token.methods
      .mint_to_private(initializerlessAccount.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    await token.methods
      .mint_to_private(standardAccount.contract.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const initialInitializerlessPrivateBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });
    expect(initialInitializerlessPrivateBalance).toEqual(MINT_AMOUNT);

    const initialStandardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(initialStandardPrivateBalance).toEqual(MINT_AMOUNT);

    // Transfer amounts
    const TRANSFER_TO_STANDARD = 100n;
    const TRANSFER_TO_PUBLIC = 100n;
    const TRANSFER_TO_INITIALIZERLESS = 50n;

    // 1. InitializerlessAccount transfers 100 private tokens to StandardAccount
    await token.methods
      .transfer_private_to_private(
        initializerlessAccount.address, // from
        standardAccount.contract.address, // to
        TRANSFER_TO_STANDARD, // amount
        0n, // nonce (0 when sender is caller)
      )
      .send({
        from: initializerlessAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    const tx1InitializerlessPrivateBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx1InitializerlessPrivateBalance).toEqual(
      initialInitializerlessPrivateBalance - TRANSFER_TO_STANDARD,
    );

    const tx1StandardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(tx1StandardPrivateBalance).toEqual(
      initialStandardPrivateBalance + TRANSFER_TO_STANDARD,
    );

    // 2. InitializerlessAccount transfers 100 private tokens to self as public
    await token.methods
      .transfer_private_to_public(
        initializerlessAccount.address, // from
        initializerlessAccount.address, // to (self)
        TRANSFER_TO_PUBLIC, // amount
        0n, // nonce
      )
      .send({
        from: initializerlessAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    const tx2InitializerlessPrivateBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx2InitializerlessPrivateBalance).toEqual(
      tx1InitializerlessPrivateBalance - TRANSFER_TO_PUBLIC,
    );

    const tx2InitializerlessPublicBalance = await token.methods
      .balance_of_public(initializerlessAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx2InitializerlessPublicBalance).toEqual(TRANSFER_TO_PUBLIC);

    // 3. StandardAccount transfers 50 private tokens to InitializerlessAccount
    await token.methods
      .transfer_private_to_private(
        standardAccount.contract.address, // from
        initializerlessAccount.address, // to
        TRANSFER_TO_INITIALIZERLESS, // amount
        0n, // nonce
      )
      .send({
        from: standardAccount.contract.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    const tx3InitializerlessPrivateBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx3InitializerlessPrivateBalance).toEqual(
      tx2InitializerlessPrivateBalance + TRANSFER_TO_INITIALIZERLESS,
    );

    const tx3StandardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(tx3StandardPrivateBalance).toEqual(
      tx1StandardPrivateBalance - TRANSFER_TO_INITIALIZERLESS,
    );

    // Verify final balances
    // InitializerlessAccount: 1000 - 100 (to standard) - 100 (to public) + 50 (from standard) = 850 private, 100 public
    // StandardAccount: 1000 + 100 (from initializerless) - 50 (to initializerless) = 1050 private, 0 public
    const expectedInitializerlessPrivate =
      MINT_AMOUNT -
      TRANSFER_TO_STANDARD -
      TRANSFER_TO_PUBLIC +
      TRANSFER_TO_INITIALIZERLESS;
    const expectedInitializerlessPublic = TRANSFER_TO_PUBLIC;
    const expectedStandardPrivate =
      MINT_AMOUNT + TRANSFER_TO_STANDARD - TRANSFER_TO_INITIALIZERLESS;
    const expectedStandardPublic = 0n;

    const initializerlessPrivateBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });

    const initializerlessPublicBalance = await token.methods
      .balance_of_public(initializerlessAccount.address)
      .simulate({ from: deployerAddress });

    const standardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });

    const standardPublicBalance = await token.methods
      .balance_of_public(standardAccount.contract.address)
      .simulate({ from: deployerAddress });

    expect(initializerlessPrivateBalance).toEqual(
      expectedInitializerlessPrivate,
    );
    expect(initializerlessPublicBalance).toEqual(expectedInitializerlessPublic);
    expect(standardPrivateBalance).toEqual(expectedStandardPrivate);
    expect(standardPublicBalance).toEqual(expectedStandardPublic);
  });

  it("should verify auth witness for delegated transfer", async () => {
    // Deploy an initializerless account and give it tokens
    const initializerlessAccount = await deployAndRegister(wallet, {
      secretKey: Fr.random(),
    });

    // Snapshot deployer balance before (may have accumulated from prior tests)
    const deployerBalanceBefore = await token.methods
      .balance_of_private(deployerAddress)
      .simulate({ from: deployerAddress });

    // Deployer mints tokens to the initializerless account
    await token.methods
      .mint_to_private(initializerlessAccount.address, MINT_AMOUNT)
      .send({ from: deployerAddress });

    const TRANSFER_AMOUNT = 100n;
    const nonce = Fr.random();

    // Create the action that deployerAddress wants to execute on behalf of initializerlessAccount
    const action = token.methods.transfer_private_to_private(
      initializerlessAccount.address,
      deployerAddress,
      TRANSFER_AMOUNT,
      nonce,
    );

    // initializerlessAccount creates an auth witness approving this action
    const witness = await wallet.createAuthWit(initializerlessAccount.address, {
      caller: deployerAddress,
      action,
    });

    // deployerAddress executes the transfer on behalf of initializerlessAccount
    // Signing key loaded from persistent store (store_immutables called during deployment)
    const tx = await token.methods
      .transfer_private_to_private(
        initializerlessAccount.address,
        deployerAddress,
        TRANSFER_AMOUNT,
        nonce,
      )
      .with({ authWitnesses: [witness] })
      .send({
        from: deployerAddress,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);

    // Verify balances
    const initializerlessBalance = await token.methods
      .balance_of_private(initializerlessAccount.address)
      .simulate({ from: deployerAddress });
    expect(initializerlessBalance).toEqual(MINT_AMOUNT - TRANSFER_AMOUNT);

    const deployerBalanceAfter = await token.methods
      .balance_of_private(deployerAddress)
      .simulate({ from: deployerAddress });
    expect(deployerBalanceAfter).toEqual(
      deployerBalanceBefore + TRANSFER_AMOUNT,
    );
  });

  it("should verify contract metadata for published vs unpublished accounts", async () => {
    // Deploy a published account
    const publishedAccount = await deployAndRegister(wallet, {
      secretKey: Fr.random(),
      publishClass: true,
      publishInstance: true,
    });

    // Deploy an unpublished account (PXE-only, default behavior)
    const unpublishedAccount = await deployAndRegister(wallet, {
      secretKey: Fr.random(),
    });

    // Check contract metadata for published account
    const publishedMetadata = await wallet.getContractMetadata(
      publishedAccount.address,
    );

    expect(publishedMetadata.isContractPublished).toBe(true);
    expect(publishedMetadata.isContractInitialized).toBe(false);

    // Check contract metadata for unpublished account
    const unpublishedMetadata = await wallet.getContractMetadata(
      unpublishedAccount.address,
    );

    expect(unpublishedMetadata.isContractPublished).toBe(false);
    expect(unpublishedMetadata.isContractInitialized).toBe(false);
  });
});
