/**
 * E2E Tests for SchnorrInitializerlessAccount
 *
 * These tests verify the initializerless immutables pattern for an account contract
 * that stores a signing public key committed via salt.
 *
 * Unlike Noir TXE tests, these E2E tests have full control over deployment and
 * properly verify the immutables pattern works end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import {
  createSigningKeyCapsule,
  computeContractSalt,
  computeSchnorrAccountAddress,
  deploySchnorrInitializerlessAccount,
  type SigningPublicKey,
} from "./schnorr-initializerless-account/index.js";
import { setupTestSuite, type CustomEmbeddedWallet } from "./utils.js";

const SIGNING_KEY_1 = {
  x: new Fr(111n),
  y: new Fr(222n),
};
const SIGNING_KEY_2 = {
  x: new Fr(333n),
  y: new Fr(444n),
};
const ACTUAL_SALT_1 = new Fr(12345n);
const ACTUAL_SALT_2 = new Fr(54321n);

describe("SchnorrInitializerlessAccount - Initializerless Immutables Pattern", () => {
  let cleanup: () => Promise<void>;
  let wallet: CustomEmbeddedWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      cleanup,
      wallet,
      accounts: [alice],
    } = await setupTestSuite());
  });

  afterAll(async () => {
    await cleanup();
  });

  // Pure computation tests (no deployment, no published/unpublished distinction)
  it("should produce different addresses for different signing keys", async () => {
    // Compute addresses with fixed actualSalt for determinism
    const result1 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_1,
    });
    const result2 = await computeSchnorrAccountAddress(SIGNING_KEY_2, {
      actualSalt: ACTUAL_SALT_1,
    });

    // Different signing keys should produce different addresses
    expect(result1.address.toString()).not.toBe(result2.address.toString());
  });

  it("should produce different addresses for different actualSalt", async () => {
    // Compute addresses with same signing key but different actualSalt
    const result1 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_1,
    });
    const result2 = await computeSchnorrAccountAddress(SIGNING_KEY_1, {
      actualSalt: ACTUAL_SALT_2,
    });

    // Different actualSalt should produce different addresses
    expect(result1.address.toString()).not.toBe(result2.address.toString());
  });

  it("should compute correct contract salt", async () => {
    const salt = computeContractSalt(ACTUAL_SALT_1, SIGNING_KEY_1);

    // Salt should be non-zero
    expect(salt.toBigInt()).not.toBe(0n);

    // Same inputs should produce same salt
    const salt2 = computeContractSalt(ACTUAL_SALT_1, SIGNING_KEY_1);
    expect(salt.toBigInt()).toBe(salt2.toBigInt());

    // Different key should produce different salt
    const differentSalt = computeContractSalt(ACTUAL_SALT_1, SIGNING_KEY_2);
    expect(salt.toBigInt()).not.toBe(differentSalt.toBigInt());

    // Different actualSalt should produce different salt
    const saltWithDifferentActual = computeContractSalt(
      ACTUAL_SALT_2,
      SIGNING_KEY_1,
    );
    expect(salt.toBigInt()).not.toBe(saltWithDifferentActual.toBigInt());
  });

  // Published deployment tests
  describe("Published", () => {
    it("should deploy account with signing key and read it back", async () => {
      const { contract, capsuleData, signingPublicKey, instance } =
        await deploySchnorrInitializerlessAccount(wallet, alice, {
          publishClass: true,
          publishInstance: true,
        });

      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      // Verify instance IS published on-chain
      const metadata = await wallet.getContractMetadata(contract.address);
      expect(metadata.isContractPublished).toBe(true);

      // Immutables loaded from persistent store (store_immutables called during deployment)
      const { result } = await contract.methods
        .get_signing_public_key()
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
      expect(result[1]).toEqual(signingPublicKey.y.toBigInt());

      // Verify pre-computed address matches deployed address (TS-Noir agreement)
      const { address: preComputedAddress } =
        await computeSchnorrAccountAddress(signingPublicKey, {
          actualSalt: capsuleData[0],
          publicKeys: instance.publicKeys,
        });
      expect(preComputedAddress.toString()).toBe(contract.address.toString());
    });

    it("should deploy with different secret keys and get different addresses", async () => {
      const account1 = await deploySchnorrInitializerlessAccount(
        wallet,
        alice,
        {
          secretKey: Fr.random(),
          publishClass: true,
          publishInstance: true,
        },
      );
      const account2 = await deploySchnorrInitializerlessAccount(
        wallet,
        alice,
        {
          secretKey: Fr.random(),
          publishInstance: true,
        },
      );

      // Different secrets should produce different addresses
      expect(account1.address.toString()).not.toBe(account2.address.toString());

      // Verify each contract returns its correct key (loaded from persistent store)
      const { result: result1 } = await account1.contract.methods
        .get_signing_public_key()
        .simulate({ from: alice });

      expect(result1[0]).toEqual(account1.signingPublicKey.x.toBigInt());
      expect(result1[1]).toEqual(account1.signingPublicKey.y.toBigInt());

      const { result: result2 } = await account2.contract.methods
        .get_signing_public_key()
        .simulate({ from: alice });

      expect(result2[0]).toEqual(account2.signingPublicKey.x.toBigInt());
      expect(result2[1]).toEqual(account2.signingPublicKey.y.toBigInt());
    });

    it("should fail with wrong capsule data", async () => {
      const { contract, capsuleData, signingPublicKey } =
        await deploySchnorrInitializerlessAccount(wallet, alice);

      // Try to call with a different (wrong) signing key in capsule
      const wrongKey: SigningPublicKey = {
        x: new Fr(signingPublicKey.x.toBigInt() + 1n),
        y: new Fr(signingPublicKey.y.toBigInt() + 1n),
      };
      const wrongCapsule = createSigningKeyCapsule(
        contract.address,
        capsuleData[0],
        wrongKey,
      );

      // This should fail because the capsule data doesn't match salt
      await expect(
        contract.methods
          .get_signing_public_key()
          .with({ capsules: [wrongCapsule] })
          .simulate({ from: alice }),
      ).rejects.toThrow("Immutables do not match contract salt");
    });

    it("should fail with wrong actualSalt in capsule", async () => {
      const { contract, capsuleData, signingPublicKey } =
        await deploySchnorrInitializerlessAccount(wallet, alice);

      // Correct key but wrong actualSalt
      const wrongActualSalt = new Fr(capsuleData[0].toBigInt() + 1n);
      const wrongCapsule = createSigningKeyCapsule(
        contract.address,
        wrongActualSalt,
        signingPublicKey,
      );

      // This should fail because the hash([wrongActualSalt, key]) won't match salt
      await expect(
        contract.methods
          .get_signing_public_key()
          .with({ capsules: [wrongCapsule] })
          .simulate({ from: alice }),
      ).rejects.toThrow("Immutables do not match contract salt");
    });
  });

  // Unpublished (PXE-only) deployment tests
  describe("Unpublished (PXE-only)", () => {
    it("should deploy unpublished account and read signing key back", async () => {
      const { contract, signingPublicKey } =
        await deploySchnorrInitializerlessAccount(wallet, alice);

      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      // Verify instance is NOT published on-chain
      const metadata = await wallet.getContractMetadata(contract.address);
      expect(metadata.isContractPublished).toBe(false);

      // Immutables loaded from persistent store (store_immutables called during deployment)
      const { result } = await contract.methods
        .get_signing_public_key()
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(signingPublicKey.x.toBigInt());
      expect(result[1]).toEqual(signingPublicKey.y.toBigInt());
    });

    it("should deploy unpublished with different secret keys and get different addresses", async () => {
      const account1 = await deploySchnorrInitializerlessAccount(
        wallet,
        alice,
        {
          secretKey: Fr.random(),
        },
      );
      const account2 = await deploySchnorrInitializerlessAccount(
        wallet,
        alice,
        {
          secretKey: Fr.random(),
        },
      );

      // Different secrets should produce different addresses
      expect(account1.address.toString()).not.toBe(account2.address.toString());

      // Verify each contract returns its correct key (loaded from persistent store)
      const { result: result1 } = await account1.contract.methods
        .get_signing_public_key()
        .simulate({ from: alice });

      expect(result1[0]).toEqual(account1.signingPublicKey.x.toBigInt());
      expect(result1[1]).toEqual(account1.signingPublicKey.y.toBigInt());

      const { result: result2 } = await account2.contract.methods
        .get_signing_public_key()
        .simulate({ from: alice });

      expect(result2[0]).toEqual(account2.signingPublicKey.x.toBigInt());
      expect(result2[1]).toEqual(account2.signingPublicKey.y.toBigInt());
    });
  });
});
