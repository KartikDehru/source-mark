/**
 * SourcePayouts — contract tests.
 *
 * The contract holds other people's money and decides who loses it, so these
 * tests are written around the properties that must not break rather than
 * around line coverage:
 *
 *   1. Solvency. Every tinybar in the contract is claimed by exactly one of
 *      operatorBalance, a withdrawable balance, or an unvested lot.
 *   2. The operator cannot reach source funds under any path.
 *   3. Slashing can only ever take unvested revenue, never cleared revenue.
 *   4. A refund is never promised beyond what is actually held.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { keccak256, toBytes, parseEther, getAddress } from 'viem';

// Side-effect type imports. These plugins augment NetworkConnection with
// `viem` and `networkHelpers`; without them tsc sees a bare connection.
import type {} from '@nomicfoundation/hardhat-viem';
import type {} from '@nomicfoundation/hardhat-network-helpers';

const { viem, networkHelpers } = await network.getOrCreate();

const ROUTING_FEE_BPS = 1000n; // 10%
const HOLDBACK_BPS = 2000n; // 20% of a source's cut
const VESTING = 604800n; // 7 days
const BOND = parseEther('0.1');

const SRC_A = keccak256(toBytes('QmDeploymentAaveV3One'));
const SRC_B = keccak256(toBytes('QmDeploymentAaveV3Two'));
const DIGEST = keccak256(toBytes('receipt-1'));

type Deployed = Awaited<ReturnType<typeof deploy>>;

async function deploy() {
  const clients = await viem.getWalletClients();
  const nth = (i: number) => {
    const c = clients[i];
    if (!c) throw new Error(`expected at least ${i + 1} wallet clients, got ${clients.length}`);
    return c;
  };
  const [operator, arbiter, buyer, payeeA, payeeB, stranger] = [nth(0), nth(1), nth(2), nth(3), nth(4), nth(5)];
  const publicClient = await viem.getPublicClient();

  const contract = await viem.deployContract('SourcePayouts', [
    arbiter.account.address,
    Number(ROUTING_FEE_BPS),
    Number(HOLDBACK_BPS),
    VESTING,
    BOND,
  ]);

  await contract.write.registerSource([SRC_A, payeeA.account.address]);
  await contract.write.registerSource([SRC_B, payeeB.account.address]);

  return { contract, publicClient, operator, arbiter, buyer, payeeA, payeeB, stranger };
}

/** Sum of everything the contract believes it owes, which must equal its balance. */
async function accountedFor(d: Deployed, sources: readonly `0x${string}`[]): Promise<bigint> {
  let total = await d.contract.read.operatorBalance();
  for (const id of sources) {
    total += await d.contract.read.withdrawable([id]);
    total += await d.contract.read.unvestedHoldback([id]);
  }
  return total;
}

async function balanceOf(d: Deployed, address: `0x${string}`): Promise<bigint> {
  return d.publicClient.getBalance({ address });
}

describe('SourcePayouts', () => {
  let d: Deployed;
  beforeEach(async () => {
    d = await deploy();
  });

  describe('recording a read', () => {
    it('splits gross into fee, cleared revenue and holdback with nothing lost', async () => {
      const gross = parseEther('1');
      await d.contract.write.recordRead([DIGEST, [SRC_A, SRC_B], d.buyer.account.address], { value: gross });

      const fee = (gross * ROUTING_FEE_BPS) / 10_000n;
      const per = (gross - fee) / 2n;
      const held = (per * HOLDBACK_BPS) / 10_000n;
      const vested = per - held;

      assert.equal(await d.contract.read.withdrawable([SRC_A]), vested);
      assert.equal(await d.contract.read.unvestedHoldback([SRC_A]), held);
      assert.equal(await d.contract.read.operatorBalance(), fee);

      // Solvency: the contract's balance is fully attributed.
      const onChain = await balanceOf(d, d.contract.address);
      assert.equal(onChain, gross);
      assert.equal(await accountedFor(d, [SRC_A, SRC_B]), gross);
    });

    it('keeps rounding dust with the operator rather than losing it', async () => {
      // 7 wei across 3 sources cannot divide evenly at any stage.
      const gross = 7n;
      const third = keccak256(toBytes('QmDeploymentThird'));
      await d.contract.write.registerSource([third, d.stranger.account.address]);

      await d.contract.write.recordRead([DIGEST, [SRC_A, SRC_B, third], d.buyer.account.address], { value: gross });

      assert.equal(await accountedFor(d, [SRC_A, SRC_B, third]), gross);
    });

    it('refuses a read that names an unregistered source', async () => {
      const ghost = keccak256(toBytes('QmNeverRegistered'));
      await assert.rejects(
        d.contract.write.recordRead([DIGEST, [SRC_A, ghost], d.buyer.account.address], { value: parseEther('1') }),
        /UnknownSource/,
      );
    });

    it('refuses a duplicate receipt digest', async () => {
      await d.contract.write.recordRead([DIGEST, [SRC_A], d.buyer.account.address], { value: parseEther('1') });
      await assert.rejects(
        d.contract.write.recordRead([DIGEST, [SRC_A], d.buyer.account.address], { value: parseEther('1') }),
        /DuplicateReceipt/,
      );
    });

    it('refuses a read with no buyer, since an upheld dispute would burn the refund', async () => {
      await assert.rejects(
        d.contract.write.recordRead([DIGEST, [SRC_A], '0x0000000000000000000000000000000000000000'], {
          value: parseEther('1'),
        }),
        /BadParams/,
      );
    });

    it('refuses a read with no value or no sources', async () => {
      await assert.rejects(
        d.contract.write.recordRead([DIGEST, [SRC_A], d.buyer.account.address], { value: 0n }),
        /NoValue/,
      );
      await assert.rejects(
        d.contract.write.recordRead([DIGEST, [], d.buyer.account.address], { value: parseEther('1') }),
        /NoSources/,
      );
    });

    it('cannot be called by a stranger, so receipt digests cannot be squatted', async () => {
      // Without this gate anyone can pre-record the digest the gateway is about
      // to use, for 1 wei, and the gateway's real call then reverts as a
      // duplicate — griefing every settlement for the price of gas.
      const asStranger = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.stranger },
      });

      await assert.rejects(
        asStranger.write.recordRead([DIGEST, [SRC_A], d.buyer.account.address], { value: 1n }),
        /NotRecorder/,
      );

      // The gateway's own call still lands.
      await d.contract.write.recordRead([DIGEST, [SRC_A], d.buyer.account.address], { value: parseEther('1') });
      const receipt = await d.contract.read.receiptOf([DIGEST]);
      assert.equal(receipt.gross, parseEther('1'));
    });

    it('lets the operator delegate recording to a hot gateway key it can rotate', async () => {
      await d.contract.write.setRecorder([d.stranger.account.address]);
      const asGateway = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.stranger },
      });

      await asGateway.write.recordRead([DIGEST, [SRC_A], d.buyer.account.address], { value: parseEther('1') });
      assert.equal((await d.contract.read.receiptOf([DIGEST])).gross, parseEther('1'));

      // Rotating away revokes it immediately.
      await d.contract.write.setRecorder([d.operator.account.address]);
      await assert.rejects(
        asGateway.write.recordRead([keccak256(toBytes('r2')), [SRC_A], d.buyer.account.address], {
          value: parseEther('1'),
        }),
        /NotRecorder/,
      );
    });
  });

  describe('claiming', () => {
    beforeEach(async () => {
      await d.contract.write.recordRead([DIGEST, [SRC_A, SRC_B], d.buyer.account.address], { value: parseEther('1') });
    });

    it('pays cleared revenue to the registered payee only', async () => {
      const before = await balanceOf(d, d.payeeA.account.address);
      const expected = await d.contract.read.withdrawable([SRC_A]);

      const asPayee = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.payeeA },
      });
      const hash = await asPayee.write.claim([SRC_A]);
      const rcpt = await d.publicClient.waitForTransactionReceipt({ hash });
      const gas = rcpt.gasUsed * rcpt.effectiveGasPrice;

      assert.equal(await balanceOf(d, d.payeeA.account.address), before + expected - gas);
      assert.equal(await d.contract.read.withdrawable([SRC_A]), 0n);
    });

    it('refuses a claim from anyone other than the payee, including the operator', async () => {
      await assert.rejects(d.contract.write.claim([SRC_A]), /NotPayee/);

      const asPayeeB = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.payeeB },
      });
      await assert.rejects(asPayeeB.write.claim([SRC_A]), /NotPayee/);
    });

    it('gives the operator no path to source funds', async () => {
      // The only operator withdrawal is the routing fee, and it is exactly the
      // fee — not a tinybar of the sources' cut.
      const fee = await d.contract.read.operatorBalance();
      const before = await balanceOf(d, d.operator.account.address);

      const hash = await d.contract.write.withdrawOperator();
      const rcpt = await d.publicClient.waitForTransactionReceipt({ hash });
      const gas = rcpt.gasUsed * rcpt.effectiveGasPrice;

      assert.equal(await balanceOf(d, d.operator.account.address), before + fee - gas);
      assert.equal(await d.contract.read.operatorBalance(), 0n);
      await assert.rejects(d.contract.write.withdrawOperator(), /NothingToClaim/);

      // Source money is untouched and still fully backed.
      const remaining = await balanceOf(d, d.contract.address);
      assert.equal(await accountedFor(d, [SRC_A, SRC_B]), remaining);
    });

    it('withholds the holdback until it matures, then releases it', async () => {
      const asPayee = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.payeeA },
      });
      await asPayee.write.claim([SRC_A]);

      const held = await d.contract.read.unvestedHoldback([SRC_A]);
      assert.ok(held > 0n, 'expected a holdback to exist');
      assert.equal(await d.contract.read.claimable([SRC_A]), 0n);

      await networkHelpers.time.increase(Number(VESTING) + 1);

      assert.equal(await d.contract.read.unvestedHoldback([SRC_A]), 0n);
      assert.equal(await d.contract.read.claimable([SRC_A]), held);

      const before = await balanceOf(d, d.payeeA.account.address);
      const hash = await asPayee.write.claim([SRC_A]);
      const rcpt = await d.publicClient.waitForTransactionReceipt({ hash });
      const gas = rcpt.gasUsed * rcpt.effectiveGasPrice;
      assert.equal(await balanceOf(d, d.payeeA.account.address), before + held - gas);
    });

    it('cannot be drained by a payee that re-enters from its receive hook', async () => {
      const attacker = await viem.deployContract('ReentrantPayee', [d.contract.address]);
      const evil = keccak256(toBytes('QmEvil'));
      await d.contract.write.registerSource([evil, attacker.address]);
      await attacker.write.arm([evil]);

      await d.contract.write.recordRead([keccak256(toBytes('receipt-evil')), [evil], d.buyer.account.address], {
        value: parseEther('1'),
      });

      const owed = await d.contract.read.withdrawable([evil]);
      await attacker.write.attack();

      assert.equal(await balanceOf(d, attacker.address), owed, 'attacker got more than it was owed');
      assert.equal(await attacker.read.reenterFailed(), true, 're-entry should have reverted');
      assert.equal(await d.contract.read.withdrawable([evil]), 0n);
    });

    it('lets a source with a long history claim in bounded steps', async () => {
      // vest(maxLots) must let a payee make progress even if the lot list is
      // longer than one transaction can process.
      for (let i = 0; i < 12; i += 1) {
        await d.contract.write.recordRead([keccak256(toBytes(`bulk-${i}`)), [SRC_A], d.buyer.account.address], {
          value: parseEther('1'),
        });
      }
      await networkHelpers.time.increase(Number(VESTING) + 1);

      const all = await d.contract.read.claimable([SRC_A]);
      await d.contract.write.vest([SRC_A, 5n]);
      const partial = await d.contract.read.withdrawable([SRC_A]);
      assert.ok(partial > 0n && partial < all, 'bounded vest should move some but not all');

      await d.contract.write.vest([SRC_A, 256n]);
      assert.equal(await d.contract.read.withdrawable([SRC_A]), all);
      assert.equal(await d.contract.read.unvestedHoldback([SRC_A]), 0n);
    });
  });

  describe('disputes', () => {
    beforeEach(async () => {
      await d.contract.write.recordRead([DIGEST, [SRC_A, SRC_B], d.buyer.account.address], { value: parseEther('1') });
    });

    it('is open to anyone willing to post the bond', async () => {
      const asStranger = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.stranger },
      });
      await asStranger.write.openDispute([DIGEST, 'reported rate never existed onchain'], { value: BOND });

      const dispute = await d.contract.read.disputeOf([DIGEST]);
      assert.equal(getAddress(dispute.claimant), getAddress(d.stranger.account.address));
      assert.equal(dispute.bond, BOND);
      assert.equal(dispute.resolved, false);
    });

    it('rejects a wrong bond, an unknown receipt, and a second dispute', async () => {
      await assert.rejects(d.contract.write.openDispute([DIGEST, 'x'], { value: BOND - 1n }), /BadBond/);
      await assert.rejects(
        d.contract.write.openDispute([keccak256(toBytes('nope')), 'x'], { value: BOND }),
        /UnknownReceipt/,
      );

      await d.contract.write.openDispute([DIGEST, 'first'], { value: BOND });
      await assert.rejects(d.contract.write.openDispute([DIGEST, 'second'], { value: BOND }), /AlreadyDisputed/);
    });

    it('refunds the buyer out of unvested holdback and returns the bond when upheld', async () => {
      const asStranger = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.stranger },
      });
      await asStranger.write.openDispute([DIGEST, 'falsified'], { value: BOND });

      const heldA = await d.contract.read.unvestedHoldback([SRC_A]);
      const heldB = await d.contract.read.unvestedHoldback([SRC_B]);
      const buyerBefore = await balanceOf(d, d.buyer.account.address);
      const claimantBefore = await balanceOf(d, d.stranger.account.address);

      const asArbiter = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.arbiter },
      });
      await asArbiter.write.resolveDispute([DIGEST, true]);

      // The refund is exactly what was actually held back, not the notional
      // per-source share of gross.
      assert.equal(await balanceOf(d, d.buyer.account.address), buyerBefore + heldA + heldB);
      assert.equal(await balanceOf(d, d.stranger.account.address), claimantBefore + BOND);
      assert.equal(await d.contract.read.unvestedHoldback([SRC_A]), 0n);
      assert.equal(await d.contract.read.unvestedHoldback([SRC_B]), 0n);
    });

    it('recovers nothing once the holdback has vested, which is the design limit', async () => {
      // The honest boundary: the liability window is exactly `vestingSeconds`.
      // A dispute raised after it is too late, and the contract should not
      // pretend otherwise by reaching into cleared revenue.
      await networkHelpers.time.increase(Number(VESTING) + 1);

      await d.contract.write.openDispute([DIGEST, 'too late'], { value: BOND });
      const buyerBefore = await balanceOf(d, d.buyer.account.address);

      const asArbiter = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.arbiter },
      });
      await asArbiter.write.resolveDispute([DIGEST, true]);

      assert.equal(await balanceOf(d, d.buyer.account.address), buyerBefore, 'nothing should be recoverable');
    });

    it('cannot be outlasted by a source waiting for its holdback to vest', async () => {
      // The attack: challenge lands inside the window, but the arbiter rules
      // after it. Maturity must be judged as of the dispute, not the ruling,
      // and vesting must be frozen in between.
      const heldA = await d.contract.read.unvestedHoldback([SRC_A]);
      const heldB = await d.contract.read.unvestedHoldback([SRC_B]);
      assert.ok(heldA > 0n);

      await d.contract.write.openDispute([DIGEST, 'challenged while unvested'], { value: BOND });

      // Source tries to run the clock out and cash in before the ruling.
      await networkHelpers.time.increase(Number(VESTING) + 1);
      await d.contract.write.vest([SRC_A, 256n]);

      // The holdback matured on paper but is still held, so the arbiter can
      // still reach it. The separately-vested cut is untouched by design.
      assert.equal(await d.contract.read.unclearedHoldback([SRC_A]), heldA, 'frozen holdback must not clear');
      assert.equal(await d.contract.read.claimable([SRC_A]), await d.contract.read.withdrawable([SRC_A]));

      const asPayee = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.payeeA },
      });
      // Claiming pays only the cut that had already cleared before the
      // challenge; it cannot pull the frozen holdback out.
      await asPayee.write.claim([SRC_A]);
      assert.equal(await d.contract.read.unclearedHoldback([SRC_A]), heldA, 'claim must not release frozen holdback');

      // Ruling still recovers the full holdback.
      const buyerBefore = await balanceOf(d, d.buyer.account.address);
      const asArbiter = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.arbiter },
      });
      await asArbiter.write.resolveDispute([DIGEST, true]);

      assert.equal(await balanceOf(d, d.buyer.account.address), buyerBefore + heldA + heldB);
    });

    it('unfreezes the holdback once a dispute is rejected', async () => {
      const heldA = await d.contract.read.unvestedHoldback([SRC_A]);
      const clearedA = await d.contract.read.withdrawable([SRC_A]);

      await d.contract.write.openDispute([DIGEST, 'spam'], { value: BOND });
      await networkHelpers.time.increase(Number(VESTING) + 1);

      // Frozen: matured but not claimable.
      assert.equal(await d.contract.read.claimable([SRC_A]), clearedA);

      const asArbiter = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.arbiter },
      });
      await asArbiter.write.resolveDispute([DIGEST, false]);

      // The source keeps everything; only the spammer's bond moved.
      assert.equal(await d.contract.read.claimable([SRC_A]), clearedA + heldA);

      const asPayee = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.payeeA },
      });
      await asPayee.write.claim([SRC_A]);
      assert.equal(await d.contract.read.claimable([SRC_A]), 0n);
      assert.equal(await d.contract.read.unclearedHoldback([SRC_A]), 0n);
    });

    it('hands a rejected dispute bond to the operator and resolves only once', async () => {
      await d.contract.write.openDispute([DIGEST, 'spam'], { value: BOND });
      const feeBefore = await d.contract.read.operatorBalance();

      const asArbiter = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.arbiter },
      });
      await asArbiter.write.resolveDispute([DIGEST, false]);

      assert.equal(await d.contract.read.operatorBalance(), feeBefore + BOND);
      await assert.rejects(asArbiter.write.resolveDispute([DIGEST, false]), /DisputeAlreadyResolved/);
    });

    it('can only be resolved by the arbiter, not the operator', async () => {
      await d.contract.write.openDispute([DIGEST, 'x'], { value: BOND });
      await assert.rejects(d.contract.write.resolveDispute([DIGEST, true]), /NotArbiter/);
    });

    it('stays solvent through a full dispute cycle', async () => {
      await d.contract.write.openDispute([DIGEST, 'x'], { value: BOND });
      const asArbiter = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.arbiter },
      });
      await asArbiter.write.resolveDispute([DIGEST, true]);

      const onChain = await balanceOf(d, d.contract.address);
      assert.equal(await accountedFor(d, [SRC_A, SRC_B]), onChain);
    });
  });

  describe('configuration', () => {
    it('rejects a fee plus holdback over 100% and a zero arbiter', async () => {
      await assert.rejects(
        viem.deployContract('SourcePayouts', [d.arbiter.account.address, 6000, 5000, VESTING, BOND]),
        /BadParams/,
      );
      await assert.rejects(
        viem.deployContract('SourcePayouts', [
          '0x0000000000000000000000000000000000000000',
          1000,
          2000,
          VESTING,
          BOND,
        ]),
        /BadParams/,
      );
    });

    it('lets only the operator rotate the arbiter', async () => {
      const asStranger = await viem.getContractAt('SourcePayouts', d.contract.address, {
        client: { wallet: d.stranger },
      });
      await assert.rejects(asStranger.write.setArbiter([d.stranger.account.address]), /NotOperator/);
      await assert.rejects(asStranger.write.setRecorder([d.stranger.account.address]), /NotOperator/);

      await d.contract.write.setArbiter([d.stranger.account.address]);
      assert.equal(getAddress(await d.contract.read.arbiter()), getAddress(d.stranger.account.address));
    });
  });
});
