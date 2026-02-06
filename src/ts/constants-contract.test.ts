import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TestWallet } from "@aztec/test-wallet/server";
import { AztecAddress } from "@aztec/stdlib/aztec-address";
import { Fr } from "@aztec/aztec.js/fields";
import { type AztecLMDBStoreV2 } from "@aztec/kv-store/lmdb-v2";
import {
  deployConstantsContract,
  deployMixedUsageContract,
  createConstantsCapsule,
  serializeConstants,
  type Constants,
  computeContractSalt,
} from "./constants-contract/utils.js";
import { setupTestSuite } from "./utils.js";

const CONSTANTS_1: Constants = {
  signingKeyX: new Fr(111n),
  signingKeyY: new Fr(222n),
};
const CONSTANTS_2: Constants = {
  signingKeyX: new Fr(333n),
  signingKeyY: new Fr(444n),
};
const ACTUAL_SALT_1 = new Fr(12345n);
const ACTUAL_SALT_2 = new Fr(54321n);
const INITIAL_COUNTER = 42n;

describe("Constants Contract - Initializerless Pattern", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite("constants"));
  });

  afterAll(async () => {
    await store.delete();
  });

  // Pure computation tests (no deployment, no published/unpublished distinction)
  it("should produce different addresses for different actualSalt", async () => {
    // Deploy two contracts with same constants but different actualSalt
    const { contract: contract1 } = await deployConstantsContract(
      wallet,
      CONSTANTS_1,
      { actualSalt: ACTUAL_SALT_1 },
    );
    const { contract: contract2 } = await deployConstantsContract(
      wallet,
      CONSTANTS_1,
      { actualSalt: ACTUAL_SALT_2, skipClassPublication: true },
    );

    // Different actualSalt should produce different addresses
    expect(contract1.address.toString()).not.toBe(contract2.address.toString());
  });

  it("should compute correct contract salt", async () => {
    const actualSalt = new Fr(12345n);
    const salt = computeContractSalt(
      ACTUAL_SALT_1,
      serializeConstants(CONSTANTS_1),
    );

    // Salt should be non-zero
    expect(salt.toBigInt()).not.toBe(0n);

    // Same inputs should produce same salt
    const salt2 = computeContractSalt(
      ACTUAL_SALT_1,
      serializeConstants(CONSTANTS_1),
    );
    expect(salt.toBigInt()).toBe(salt2.toBigInt());

    // Different constants should produce different salt
    const differentSalt = computeContractSalt(
      ACTUAL_SALT_1,
      serializeConstants(CONSTANTS_2),
    );
    expect(salt.toBigInt()).not.toBe(differentSalt.toBigInt());

    // Different actualSalt should produce different salt
    const saltWithDifferentActual = computeContractSalt(
      ACTUAL_SALT_2,
      serializeConstants(CONSTANTS_1),
    );
    expect(salt.toBigInt()).not.toBe(saltWithDifferentActual.toBigInt());
  });

  // Published deployment tests
  describe("Published", () => {
    it("should deploy contract with constants and read them back", async () => {
      const { contract, actualSalt, isPublished } =
        await deployConstantsContract(wallet, CONSTANTS_1);

      expect(isPublished).toBe(true);
      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      const capsule = createConstantsCapsule(
        contract.address,
        actualSalt,
        serializeConstants(CONSTANTS_1),
      );

      const result = await contract.methods
        .get_signing_key()
        .with({ capsules: [capsule] })
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(CONSTANTS_1.signingKeyX.toBigInt());
      expect(result[1]).toEqual(CONSTANTS_1.signingKeyY.toBigInt());
    });
  });

  // Unpublished (PXE-only) deployment tests
  describe("Unpublished (PXE-only)", () => {
    it("should deploy unpublished contract and read constants back", async () => {
      const { contract, actualSalt, isPublished } =
        await deployConstantsContract(wallet, CONSTANTS_1, {
          skipInstancePublication: true,
        });

      expect(isPublished).toBe(false);
      expect(contract.address).toBeDefined();
      expect(contract.address.toString()).not.toBe(
        AztecAddress.ZERO.toString(),
      );

      const capsule = createConstantsCapsule(
        contract.address,
        actualSalt,
        serializeConstants(CONSTANTS_1),
      );

      const result = await contract.methods
        .get_signing_key()
        .with({ capsules: [capsule] })
        .simulate({
          from: alice,
        });

      expect(result[0]).toEqual(CONSTANTS_1.signingKeyX.toBigInt());
      expect(result[1]).toEqual(CONSTANTS_1.signingKeyY.toBigInt());
    });
  });
});

describe("Constants Contract - Mixed Usage (Constants + Storage)", () => {
  let store: AztecLMDBStoreV2;
  let wallet: TestWallet;
  let alice: AztecAddress;

  beforeAll(async () => {
    ({
      store,
      wallet,
      accounts: [alice],
    } = await setupTestSuite("mixed-usage"));
  });

  afterAll(async () => {
    await store.delete();
  });

  it("should deploy contract with storage initialized", async () => {
    // Deploy using standard initializer pattern
    const { contract } = await deployMixedUsageContract(
      wallet,
      CONSTANTS_1,
      INITIAL_COUNTER,
    );

    // Verify contract was deployed
    expect(contract.address).toBeDefined();
    expect(contract.address.toString()).not.toBe(AztecAddress.ZERO.toString());

    // Read counter via public function - should return initial value
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER);
  });

  it("should allow storage mutation via increment", async () => {
    const { contract } = await deployMixedUsageContract(
      wallet,
      CONSTANTS_1,
      INITIAL_COUNTER,
    );

    // Increment counter via public function
    await contract.methods.increment_counter().send({ from: alice });

    // Read counter - should be incremented
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER + 1n);
  });

  it("should fail constants verification in mixed usage (expected behavior)", async () => {
    // This test documents that in mixed usage with standard deployment,
    // constants verification will fail because the contract's salt is
    // computed from deployer-chosen values, not including the constants.
    const { contract, actualSalt } = await deployMixedUsageContract(
      wallet,
      CONSTANTS_1,
      INITIAL_COUNTER,
    );

    // Storage still works
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER);

    // Create capsule for the call
    const capsule = createConstantsCapsule(
      contract.address,
      actualSalt,
      serializeConstants(CONSTANTS_1),
    );

    // But constants verification fails because:
    // - The standard deploy method computes salt from deployer-chosen values
    // - Constants::init computes poseidon2_hash([actualSalt, 555, 666])
    // - These don't match the instance.salt
    await expect(
      contract.methods
        .get_signing_key()
        .with({ capsules: [capsule] })
        .simulate({ from: alice }),
    ).rejects.toThrow("Constants do not match contract salt");
  });

  it("should fail verify_constants_and_increment due to salt mismatch (expected behavior)", async () => {
    // This tests the combined private+public function that:
    // 1. Verifies constants in private context
    // 2. Enqueues a public call to increment storage
    // Due to mixed usage, the constants verification step fails.
    const { contract, actualSalt } = await deployMixedUsageContract(
      wallet,
      CONSTANTS_1,
      INITIAL_COUNTER,
    );

    // Create capsule for the call
    const capsule = createConstantsCapsule(
      contract.address,
      actualSalt,
      serializeConstants(CONSTANTS_1),
    );

    // The private function fails at Constants::init
    // because salt doesn't include constants
    await expect(
      contract.methods
        .verify_constants_and_increment()
        .with({ capsules: [capsule] })
        .simulate({ from: alice }),
    ).rejects.toThrow("Constants do not match contract salt");

    // Storage should remain unchanged since the call failed
    const counter = await contract.methods.get_counter().simulate({
      from: alice,
    });
    expect(counter).toEqual(INITIAL_COUNTER);
  });
});
