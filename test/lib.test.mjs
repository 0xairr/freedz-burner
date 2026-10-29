import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, parseEther } from 'ethers';
import { MIN_POT, POOL, burnCalldata, nftIface, pickToken, poolIface, priceProblem, revertName, tokenTargets, usdToWei, voidsSigned, weiToUsd } from '../lib.mjs';

const ETH_2364 = 2364_00000000n; // $2,364.00 with Chainlink's 8 decimals

test('usdToWei converts and rounds up', () => {
  const wei = usdToWei(20, ETH_2364);
  // 20 / 2364 = 0.008460236886632826 ETH
  assert.equal(wei, 8460236886632826n);
  assert.ok(weiToUsd(wei, ETH_2364) >= 19.99999);
  assert.equal(usdToWei('23.64', ETH_2364), parseEther('0.01'));
});

test('usdToWei never goes below the pool MIN_POT', () => {
  assert.equal(usdToWei(0.5, ETH_2364), MIN_POT);
});

test('burnCalldata targets the pool with abi.encode(minWei)', () => {
  const owner = '0x1111111111111111111111111111111111111111';
  const args = nftIface.decodeFunctionData('safeTransferFrom', burnCalldata(owner, 1234n, 123n));
  assert.equal(args[0], owner);
  assert.equal(args[1], POOL);
  assert.equal(args[2], 1234n);
  assert.equal(AbiCoder.defaultAbiCoder().decode(['uint256'], args[3])[0], 123n);
  assert.equal(args[3].length, 2 + 64); // the pool requires exactly 32 bytes
});

test('priceProblem refuses non-positive prices and big jumps from the start price', () => {
  assert.match(priceProblem(0n, 0n), /not positive/);
  assert.match(priceProblem(-1n, ETH_2364), /not positive/);
  assert.equal(priceProblem(ETH_2364, 0n), null); // first read sets the start price
  assert.equal(priceProblem(2900_00000000n, ETH_2364), null); // +22.7%
  assert.equal(priceProblem(1800_00000000n, ETH_2364), null); // -23.9%
  assert.match(priceProblem(3000_00000000n, ETH_2364), /over 25%/);
  assert.match(priceProblem(1700_00000000n, ETH_2364), /over 25%/);
  // the first answer (no start price yet) must still be plausible
  assert.match(priceProblem(50_00000000n, 0n), /outside/);
  assert.match(priceProblem(1_000_000_00000000n, 0n), /outside/);
});

test('voidsSigned: dropped token, raised target or unit switch void old burns; lowered targets do not', () => {
  const old = [{ id: 1n, eth: parseEther('0.0128') }, { id: 2n, eth: parseEther('0.02') }];
  assert.equal(voidsSigned(old, old), false);
  assert.equal(voidsSigned(old, [old[0]]), true); // token 2 dropped
  assert.equal(voidsSigned(old, [old[0], { id: 2n, eth: parseEther('0.03') }]), true); // raised
  assert.equal(voidsSigned(old, [old[0], { id: 2n, eth: parseEther('0.015') }]), false); // lowered
  assert.equal(voidsSigned(old, [...old, { id: 3n, eth: parseEther('0.01') }]), false); // token added
  assert.equal(voidsSigned(old, [old[0], { id: 2n, usd: 40 }]), true); // ETH -> USD
});

test('tokenTargets: one value for all, one per token, ETH over USD, bad input refused', () => {
  assert.deepEqual(tokenTargets([1234n, 5678n], ['0.01283', '0.02'], []), [
    { id: 1234n, eth: parseEther('0.01283') },
    { id: 5678n, eth: parseEther('0.02') },
  ]);
  assert.deepEqual(tokenTargets([1n, 2n], [], ['30']), [{ id: 1n, usd: 30 }, { id: 2n, usd: 30 }]);
  assert.deepEqual(tokenTargets([1n], ['0.02'], ['30']), [{ id: 1n, eth: parseEther('0.02') }]);
  assert.throws(() => tokenTargets([1n, 2n, 3n], ['0.01', '0.02'], []), /1 value or 3/);
  assert.throws(() => tokenTargets([1n], [], []), /TARGET_ETH/);
  assert.throws(() => tokenTargets([], ['0.02'], []), /TOKEN_IDS/);
  assert.throws(() => tokenTargets([1n], ['0'], []), /above 0/);
});

test('pickToken: highest target the pot meets, else the lowest target', () => {
  const a = { id: 1234n, minWei: parseEther('0.01283') };
  const b = { id: 5678n, minWei: parseEther('0.02') };
  assert.equal(pickToken([b, a], parseEther('0.005')).id, 1234n); // nothing met: next to be reached
  assert.equal(pickToken([b, a], parseEther('0.015')).id, 1234n); // only the lower one met
  assert.equal(pickToken([a, b], parseEther('0.025')).id, 5678n); // both met: the pot goes to the higher ask
  assert.equal(pickToken([a], parseEther('0.025')).id, 1234n);
});

test('revertName decodes the pool errors', () => {
  assert.equal(revertName(poolIface.encodeErrorResult('RewardTooLow', [1n, 2n])), 'RewardTooLow');
  assert.equal(revertName(poolIface.encodeErrorResult('PotBelowMinimum', [0n, MIN_POT])), 'PotBelowMinimum');
  assert.equal(revertName('0x'), null);
  assert.equal(revertName('0xdeadbeef'), null);
});
