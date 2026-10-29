import { AbiCoder, Interface, parseEther, parseUnits } from 'ethers';

export const NFT = '0x993873f58f0cE4728BbD68Dd5fAbcb75Ef48e7c4'; // FREEDZ
export const POOL = '0xa603efa380d5595df6F3a01990a00c0d8f95d097'; // FreedzRewardPool
export const ETH_USD_FEED = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'; // Chainlink ETH/USD, 8 decimals
export const MIN_POT = 10n ** 15n; // the pool refuses every burn below 0.001 ETH

export const nftIface = new Interface([
  'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'error ERC721NonexistentToken(uint256 tokenId)',
  'error ERC721IncorrectOwner(address sender, uint256 tokenId, address owner)',
]);

export const poolIface = new Interface([
  'function reward() view returns (uint256)',
  'function freedz() view returns (address)',
  'event Claimed(address indexed holder, uint256 indexed tokenId, uint256 amount)',
  'error RewardTooLow(uint256 reward, uint256 minReward)',
  'error PotBelowMinimum(uint256 reward, uint256 minimum)',
  'error FreedzNotSet()',
  'error InvalidTransfer()',
  'error InvalidData()',
  'error PayoutFailed()',
]);

export const feedIface = new Interface([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/** Dollar target -> wei at a Chainlink ETH/USD answer (8 decimals). Rounded up, so a burn never
 *  takes less than asked, and never below the pool's own MIN_POT. */
export function usdToWei(usd, ethUsd8) {
  const usd8 = parseUnits(String(usd), 8);
  const wei = (usd8 * 10n ** 18n + ethUsd8 - 1n) / ethUsd8;
  return wei < MIN_POT ? MIN_POT : wei;
}

/** Why an ETH/USD answer must not be used, or null. A zero/negative price would turn any dollar
 *  target into MIN_POT, and a jump far from the price shown at startup is more likely a bad RPC
 *  than the market, so the bot stops signing rather than burn for less than the user meant. */
export function priceProblem(answer, startAnswer) {
  if (answer <= 0n) return 'ETH/USD answer is not positive';
  // The first answer has nothing to compare with, so it must at least be a plausible price.
  if (answer < 100_00000000n || answer > 100_000_00000000n) return `ETH/USD $${Number(answer) / 1e8} is outside $100-$100,000`;
  if (startAnswer && (answer * 4n < startAnswer * 3n || answer * 4n > startAnswer * 5n)) {
    return `ETH/USD moved over 25% from the start price ($${Number(startAnswer) / 1e8} -> $${Number(answer) / 1e8}); restart to accept it`;
  }
  return null;
}

export function weiToUsd(wei, ethUsd8) {
  return Number((wei * ethUsd8) / 10n ** 18n) / 1e8;
}

/** One target per token. TARGET_ETH (fixed wei) wins over TARGET_USD (converted at the live price).
 *  Either list holds one value for every token, or one value per token in TOKEN_IDS order. */
export function tokenTargets(ids, eth, usd) {
  if (!ids.length) throw new Error('set TOKEN_IDS, e.g. TOKEN_IDS=1234 (several: 1234,5678)');
  const [name, vals] = eth.length ? ['TARGET_ETH', eth] : ['TARGET_USD', usd];
  if (!vals.length) throw new Error('set TARGET_ETH (e.g. 0.02) or TARGET_USD (e.g. 20)');
  if (vals.length !== 1 && vals.length !== ids.length) throw new Error(`${name} needs 1 value or ${ids.length} (one per token)`);
  return ids.map((id, i) => {
    const v = vals.length === 1 ? vals[0] : vals[i];
    const t = eth.length ? { id, eth: parseEther(v) } : { id, usd: Number(v) };
    if (!(t.eth > 0n || t.usd > 0)) throw new Error(`${name} for #${id} must be above 0`);
    return t;
  });
}

/** True when new settings make an already-signed burn unwanted: a token dropped, a target raised, or
 *  a target switched between ETH and USD. Signed burns stay valid until their nonce is used, so the
 *  bot then voids them with a self-transfer at that nonce. Lowered targets are safe: an old burn
 *  could only fire at its own, higher minimum. */
export function voidsSigned(oldTokens, newTokens) {
  return oldTokens.some((o) => {
    const n = newTokens.find((t) => t.id === o.id);
    if (!n) return true;
    if (o.eth != null && n.eth != null) return n.eth > o.eth;
    if (o.usd != null && n.usd != null) return n.usd > o.usd;
    return true;
  });
}

/** Which token to sign for: the highest target the pot already meets (the pot goes to the token
 *  that asked most of it), else the lowest target (the next one the pot will reach). */
export function pickToken(targets, pot) {
  const met = targets.filter((t) => pot >= t.minWei);
  if (met.length) return met.reduce((a, b) => (b.minWei > a.minWei ? b : a));
  return targets.reduce((a, b) => (b.minWei < a.minWei ? b : a));
}

/** FREEDZ.safeTransferFrom(owner, POOL, tokenId, abi.encode(minWei)): the pool burns the token and
 *  pays the whole pot in the same call, or reverts (token kept) if the pot is below minWei. */
export function burnCalldata(owner, tokenId, minWei) {
  const data = AbiCoder.defaultAbiCoder().encode(['uint256'], [minWei]);
  return nftIface.encodeFunctionData('safeTransferFrom', [owner, POOL, tokenId, data]);
}

/** Name of a pool/NFT custom error in revert data, or null. */
export function revertName(data) {
  if (!data || data === '0x') return null;
  for (const iface of [poolIface, nftIface]) {
    try {
      const e = iface.parseError(data);
      if (e) return e.name;
    } catch {}
  }
  return null;
}
