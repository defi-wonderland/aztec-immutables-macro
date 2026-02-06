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
} from "./schnorr-constants-account/utils.js";
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
    ({
      store,
      wallet,
      accounts: [deployerAddress],
    } = await setupTestSuite("initializerless-dripper"));

    // Register the canonical SponsoredFPC for fee sponsorship
    // This allows accounts without fee juice to send transactions
    sponsoredFPCAddress =
      await registerDeployedSponsoredFPCInWalletAndGetAddress(wallet);
    sponsoredPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPCAddress);

    // Deploy Dripper contract (faucet)
    dripper = await DripperContract.deploy(wallet).send({
      from: deployerAddress,
    });

    // Deploy Token contract with Dripper as minter
    token = await TokenContract.deployWithOpts(
      { wallet, method: "constructor_with_minter" },
      "TestToken", // name
      "TST", // symbol
      18n, // decimals
      dripper.address, // minter = Dripper contract
      AztecAddress.ZERO, // upgrade_authority (not upgradeable)
    ).send({ from: deployerAddress });
  });

  afterAll(async () => {
    await store.delete();
  });

  it("should drip to private balance of initializerless account", async () => {
    // Deploy SchnorrConstantsAccount (initializerless pattern)
    const constantsAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });

    const initialBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });
    expect(initialBalance).toEqual(0n);

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

    // Check private balance using unconstrained function
    // Note: balance_of_private is an unconstrained function that reads from PXE state
    const finalBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });

    expect(finalBalance).toEqual(DRIP_AMOUNT);
  });

  it("should drip to private balance of standard schnorr account", async () => {
    // Deploy standard SchnorrAccount for comparison
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });

    const initialBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(initialBalance).toEqual(0n);

    // Call drip_to_private from the standard account
    const tx = await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .send({
        from: standardAccount.contract.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);

    // Check private balance
    const finalBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });

    expect(finalBalance).toEqual(DRIP_AMOUNT);
  });

  it("should allow unpublished account to send private transactions", async () => {
    const unpublishedAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
      skipInstancePublication: true,
    });
    expect(unpublishedAccount.isPublished).toBe(false);

    // Verify it's truly unpublished
    const metadata = await wallet.getContractMetadata(
      unpublishedAccount.address,
    );
    expect(metadata.isContractPublished).toBe(false);

    // Create capsule for the account (needed for every transaction)
    const capsule = createSigningKeyCapsule(
      unpublishedAccount.address,
      unpublishedAccount.actualSalt,
      unpublishedAccount.signingPublicKey,
    );

    // Try to send a transaction from the unpublished account
    const tx = await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .with({ capsules: [capsule] })
      .send({
        from: unpublishedAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);

    // Verify tokens were received
    const privateBalance = await token.methods
      .balance_of_private(unpublishedAccount.address)
      .simulate({ from: deployerAddress });

    expect(privateBalance).toEqual(DRIP_AMOUNT);
  });

  it("should allow unpublished account to send public transactions", async () => {
    const unpublishedAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
      skipInstancePublication: true,
    });
    expect(unpublishedAccount.isPublished).toBe(false);

    const capsule = createSigningKeyCapsule(
      unpublishedAccount.address,
      unpublishedAccount.actualSalt,
      unpublishedAccount.signingPublicKey,
    );

    // drip_to_public is a public function — proves the unpublished account
    // can enqueue public calls, not just private ones
    const tx = await dripper.methods
      .drip_to_public(token.address, DRIP_AMOUNT)
      .with({ capsules: [capsule] })
      .send({
        from: unpublishedAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);

    const publicBalance = await token.methods
      .balance_of_public(unpublishedAccount.address)
      .simulate({ from: deployerAddress });

    expect(publicBalance).toEqual(DRIP_AMOUNT);
  });

  it("should demonstrate both accounts working side by side with transfers", async () => {
    // Deploy both account types
    const constantsAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });
    const standardAccount = await deploySchnorrAccount(wallet, {
      secretKey: Fr.random(),
    });

    // Create capsule for the constants account (needed for every transaction)
    const capsule = createSigningKeyCapsule(
      constantsAccount.address,
      constantsAccount.actualSalt,
      constantsAccount.signingPublicKey,
    );

    // Drip to both accounts in sequence - each gets DRIP_AMOUNT (1000)
    await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .with({ capsules: [capsule] })
      .send({
        from: constantsAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    await dripper.methods.drip_to_private(token.address, DRIP_AMOUNT).send({
      from: standardAccount.contract.address,
      fee: { paymentMethod: sponsoredPaymentMethod },
    });

    const initialConstantsPrivateBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });
    expect(initialConstantsPrivateBalance).toEqual(DRIP_AMOUNT);

    const initialStandardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(initialStandardPrivateBalance).toEqual(DRIP_AMOUNT);

    // Transfer amounts
    const TRANSFER_TO_STANDARD = 100n;
    const TRANSFER_TO_PUBLIC = 100n;
    const TRANSFER_TO_CONSTANTS = 50n;

    // 1. ConstantsAccount transfers 100 private tokens to StandardAccount
    await token.methods
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

    const tx1ConstantsPrivateBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx1ConstantsPrivateBalance).toEqual(
      initialConstantsPrivateBalance - TRANSFER_TO_STANDARD,
    );

    const tx1StandardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(tx1StandardPrivateBalance).toEqual(
      initialStandardPrivateBalance + TRANSFER_TO_STANDARD,
    );

    // 2. ConstantsAccount transfers 100 private tokens to self as public
    await token.methods
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

    const tx2ConstantsPrivateBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx2ConstantsPrivateBalance).toEqual(
      tx1ConstantsPrivateBalance - TRANSFER_TO_PUBLIC,
    );

    const tx2ConstantsPublicBalance = await token.methods
      .balance_of_public(constantsAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx2ConstantsPublicBalance).toEqual(TRANSFER_TO_PUBLIC);

    // 3. StandardAccount transfers 50 private tokens to ConstantsAccount
    await token.methods
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

    const tx3ConstantsPrivateBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });
    expect(tx3ConstantsPrivateBalance).toEqual(
      tx2ConstantsPrivateBalance + TRANSFER_TO_CONSTANTS,
    );

    const tx3StandardPrivateBalance = await token.methods
      .balance_of_private(standardAccount.contract.address)
      .simulate({ from: deployerAddress });
    expect(tx3StandardPrivateBalance).toEqual(
      tx1StandardPrivateBalance - TRANSFER_TO_CONSTANTS,
    );

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

    expect(constantsPrivateBalance).toEqual(expectedConstantsPrivate);
    expect(constantsPublicBalance).toEqual(expectedConstantsPublic);
    expect(standardPrivateBalance).toEqual(expectedStandardPrivate);
    expect(standardPublicBalance).toEqual(expectedStandardPublic);
  });

  it("should reject transaction signed with wrong private key", async () => {
    // Deploy two accounts with different signing keys
    const account = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });
    const wrongAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });

    // Swap: make the wallet sign account's transactions with wrongAccount's key
    // @ts-ignore - accessing protected member for test purposes
    const wrongSigner = wallet.accounts.get(wrongAccount.address.toString());
    // @ts-ignore
    wallet.accounts.set(account.address.toString(), wrongSigner);

    // Correct capsule (loads the real public key from salt)
    const capsule = createSigningKeyCapsule(
      account.address,
      account.actualSalt,
      account.signingPublicKey,
    );

    // Should fail: capsule loads the correct public key,
    // but the signature was made with wrongAccount's private key
    await expect(
      dripper.methods
        .drip_to_private(token.address, DRIP_AMOUNT)
        .with({ capsules: [capsule] })
        .send({
          from: account.address,
          fee: { paymentMethod: sponsoredPaymentMethod },
        }),
    ).rejects.toThrow();
  });

  it("should verify auth witness for delegated transfer", async () => {
    // Deploy a constants account and give it tokens
    const constantsAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });

    const capsule = createSigningKeyCapsule(
      constantsAccount.address,
      constantsAccount.actualSalt,
      constantsAccount.signingPublicKey,
    );

    // Drip tokens to the constants account
    await dripper.methods
      .drip_to_private(token.address, DRIP_AMOUNT)
      .with({ capsules: [capsule] })
      .send({
        from: constantsAccount.address,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    const TRANSFER_AMOUNT = 100n;
    const nonce = Fr.random();

    // Create the action that deployerAddress wants to execute on behalf of constantsAccount
    const action = token.methods.transfer_private_to_private(
      constantsAccount.address,
      deployerAddress,
      TRANSFER_AMOUNT,
      nonce,
    );

    // constantsAccount creates an auth witness approving this action
    const witness = await wallet.createAuthWit(constantsAccount.address, {
      caller: deployerAddress,
      action,
    });

    // deployerAddress executes the transfer on behalf of constantsAccount
    // The capsule is needed because verify_private_authwit loads the signing key
    const tx = await token.methods
      .transfer_private_to_private(
        constantsAccount.address,
        deployerAddress,
        TRANSFER_AMOUNT,
        nonce,
      )
      .with({ capsules: [capsule], authWitnesses: [witness] })
      .send({
        from: deployerAddress,
        fee: { paymentMethod: sponsoredPaymentMethod },
      });

    expect(tx.isMined()).toBe(true);

    // Verify balances
    const constantsBalance = await token.methods
      .balance_of_private(constantsAccount.address)
      .simulate({ from: deployerAddress });
    expect(constantsBalance).toEqual(DRIP_AMOUNT - TRANSFER_AMOUNT);

    const deployerBalance = await token.methods
      .balance_of_private(deployerAddress)
      .simulate({ from: deployerAddress });
    expect(deployerBalance).toEqual(TRANSFER_AMOUNT);
  });

  it("should verify contract metadata for published vs unpublished accounts", async () => {
    // Deploy a published account (default behavior)
    const publishedAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
    });
    expect(publishedAccount.isPublished).toBe(true);

    // Deploy an unpublished account (PXE-only)
    const unpublishedAccount = await registerConstantsAccount(wallet, {
      secretKey: Fr.random(),
      skipInstancePublication: true,
    });
    expect(unpublishedAccount.isPublished).toBe(false);

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
