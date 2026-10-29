// FREEDZ auto-burner: burns your FREEDZ into the FreedzRewardPool as soon as the pot reaches each
// token's target, and collects the whole pot in the same transaction.
//
// Every block it signs one burn, with minReward = that token's target (so the pool itself refuses a
// smaller pot), and hands it to block builders as a one-tx bundle for the next two blocks. Builders
// drop bundles that revert, so a pot below target or a lost race costs nothing, and the tx never sits
// in the public mempool where another burner could copy it. Settings come from .env (see
// .env.example); `kill -HUP <pid>` re-reads the token and target settings without the password.
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { Contract, JsonRpcProvider, Transaction, Wallet, formatEther, id, parseUnits, toBeHex } from 'ethers';
import {
  ETH_USD_FEED, NFT, POOL, burnCalldata, feedIface, nftIface, pickToken, poolIface, priceProblem, revertName,
  tokenTargets, usdToWei, weiToUsd,
} from './lib.mjs';

const DRY = process.argv.includes('--dry-run');
const SLOT_SECS = 12;

function readCfg(src) {
  const env = (k, d) => (src[k] ?? '').trim() || d;
  const list = (k) => env(k, '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    rpc: env('RPC_URL', 'https://ethereum-rpc.publicnode.com'),
    keystore: env('KEYSTORE'),
    passwordFile: env('KEYSTORE_PASSWORD_FILE'),
    wallet: env('WALLET'), // dry run only: watch this address without a key
    tokens: tokenTargets(list('TOKEN_IDS').map(BigInt), list('TARGET_ETH'), list('TARGET_USD')),
    priority: parseUnits(env('PRIORITY_GWEI', '3'), 'gwei'),
    gasLimit: BigInt(env('GAS_LIMIT', '180000')),
    // Checked 2026-10-29: each answered eth_sendBundle with a bundleHash (relay.flashbots.net now
    // refuses bundles; BuilderNet is Flashbots' builder).
    builders: list('BUILDERS').length ? list('BUILDERS')
      : ['https://rpc.buildernet.org', 'https://rpc.titanbuilder.xyz', 'https://rpc.beaverbuild.org', 'https://rpc.quasar.win', 'https://rpc.lightspeedbuilder.info'],
  };
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eth = (wei) => Number(formatEther(wei)).toFixed(5);

function fail(msg) {
  console.error('error:', msg);
  process.exit(1);
}

let cfg;
try { cfg = readCfg(process.env); } catch (e) { fail(e.message); }
if (!DRY && !cfg.keystore) fail('set KEYSTORE to your encrypted keystore (cast wallet import freedz --interactive)');
if (DRY && !cfg.keystore && !cfg.wallet) fail('dry run: set KEYSTORE or WALLET');

/** Hidden password prompt (PowerShell / cmd / Windows Terminal / ssh), or KEYSTORE_PASSWORD_FILE. */
async function password() {
  if (cfg.passwordFile) return readFileSync(cfg.passwordFile, 'utf8').replace(/\r?\n$/, '');
  if (!process.stdin.isTTY) fail('no terminal for the password prompt: run from PowerShell, or set KEYSTORE_PASSWORD_FILE');
  process.stdout.write('Keystore password: ');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  let pw = '';
  return new Promise((resolve) => {
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') process.exit(130);
        if (ch === '\r' || ch === '\n') {
          process.stdin.off('data', onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write('\n');
          return resolve(pw);
        }
        pw = ch === '\b' || ch === '\u007f' ? pw.slice(0, -1) : pw + ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

const provider = new JsonRpcProvider(cfg.rpc, 1, { staticNetwork: true });
const pool = new Contract(POOL, poolIface, provider);
const nft = new Contract(NFT, nftIface, provider);
const feed = new Contract(ETH_USD_FEED, feedIface, provider);
const auth = Wallet.createRandom(); // signs X-Flashbots-Signature only; holds nothing

let signer = null;
if (cfg.keystore) {
  log('decrypting keystore...');
  signer = await Wallet.fromEncryptedJson(readFileSync(cfg.keystore, 'utf8'), await password());
}
const me = signer ? signer.address : cfg.wallet;
const mine = (owner) => owner?.toLowerCase() === me.toLowerCase();

// ETH/USD: read every minute only while a token has a TARGET_USD; otherwise once, for the $ in the log.
let price = 0n;
let priceAt = 0;
let startPrice = 0n; // the price shown at startup; later answers must stay within 25% of it
async function ethUsd() {
  if (Date.now() - priceAt > 60_000) {
    const r = await feed.latestRoundData();
    if (Date.now() / 1000 - Number(r.updatedAt) > 3 * 3600) throw new Error('Chainlink ETH/USD is stale');
    const problem = priceProblem(r.answer, startPrice);
    if (problem) throw new Error(problem);
    startPrice ||= r.answer;
    price = r.answer;
    priceAt = Date.now();
  }
  return price;
}
const usdOf = (wei) => (price ? ` ($${weiToUsd(wei, price).toFixed(2)})` : '');

const lastErr = new Map(); // builder host -> last error, printed only when it changes
async function sendBundle(raw, block) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{ txs: [raw], blockNumber: toBeHex(block) }] });
  const headers = { 'Content-Type': 'application/json', 'X-Flashbots-Signature': `${auth.address}:${await auth.signMessage(id(body))}` };
  const results = await Promise.all(cfg.builders.map(async (url) => {
    const host = new URL(url).host;
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      let j = {};
      try { j = JSON.parse(text); } catch {}
      if (!res.ok || j.error) throw new Error(j.error?.message || `HTTP ${res.status} ${text.slice(0, 80)}`);
      if (lastErr.has(host)) { lastErr.delete(host); log(`${host}: ok again`); }
      return true;
    } catch (e) {
      const msg = e.message;
      if (lastErr.get(host) !== msg) { lastErr.set(host, msg); log(`${host}: ${msg}`); }
      return false;
    }
  }));
  return results.filter(Boolean).length;
}

/** The configured tokens this wallet still holds. */
async function held(tokens) {
  const owners = await Promise.all(tokens.map((t) => nft.ownerOf(t.id).catch(() => null)));
  return tokens.filter((t, i) => {
    if (!mine(owners[i])) log(`skipping #${t.id}: owned by ${owners[i] ?? 'nobody (burned?)'}, not ${me}`);
    return mine(owners[i]);
  });
}

const targetsText = (tokens) => tokens.map((t) => `#${t.id} at ${t.eth != null ? eth(t.eth) + ' ETH' : '$' + t.usd}`).join(', ');

// ---- startup checks
if ((await pool.freedz()).toLowerCase() !== NFT.toLowerCase()) fail('pool is not linked to FREEDZ');
let active = await held(cfg.tokens);
if (!active.length) fail(`none of TOKEN_IDS is held by ${me}`);
await ethUsd().catch((e) => { if (active.some((t) => t.usd != null)) fail(e.message); });
const base0 = (await provider.getBlock('latest')).baseFeePerGas;
const needWei = cfg.gasLimit * (base0 * 2n + cfg.priority);
const balance = await provider.getBalance(me);
log(`wallet ${me} | ${eth(balance)} ETH | ${targetsText(active)}`);
log(`tip ${formatEther(cfg.priority * 10n ** 9n)} gwei${price ? ` | ETH $${weiToUsd(10n ** 18n, price).toFixed(2)}` : ''} | ${DRY ? 'DRY RUN (nothing is sent)' : cfg.builders.length + ' builders'}`);
if (balance < needWei) log(`WARNING: balance ${eth(balance)} ETH is below the ${eth(needWei)} ETH a burn may need for gas; builders will drop it`);

// SIGHUP: re-read TOKEN_IDS / TARGET_* / PRIORITY_GWEI / GAS_LIMIT / BUILDERS from .env, keeping the
// unlocked key. Applied between blocks.
let reloadWanted = false;
process.on('SIGHUP', () => { reloadWanted = true; });
async function reload() {
  reloadWanted = false;
  try {
    const next = readCfg({ ...process.env, ...parseEnv(readFileSync('.env', 'utf8')) });
    const nextActive = await held(next.tokens);
    if (!nextActive.length) throw new Error('none of the new TOKEN_IDS is held by this wallet');
    if (nextActive.some((t) => t.usd != null)) await ethUsd();
    cfg = { ...cfg, tokens: next.tokens, priority: next.priority, gasLimit: next.gasLimit, builders: next.builders };
    active = nextActive;
    sent.length = 0;
    log(`reloaded .env | ${targetsText(active)} | tip ${formatEther(cfg.priority * 10n ** 9n)} gwei`);
  } catch (e) {
    log(`reload failed, keeping the old settings: ${e.message}`);
  }
}

// ---- one pass per block until every token is burned
const sent = []; // { hash, block, id } of recent signed burns
let lastBlock = 0;
let lastTs = 0; // timestamp of the last block seen; the next one is due SLOT_SECS later

async function onBlock(n) {
  const needPrice = active.some((t) => t.usd != null);
  const [block, pot, nonce, owners] = await Promise.all([
    provider.getBlock(n),
    pool.reward({ blockTag: n }),
    provider.getTransactionCount(me, n),
    Promise.all(active.map((t) => nft.ownerOf(t.id, { blockTag: n }).catch(() => null))),
    needPrice ? ethUsd() : null,
  ]);
  lastTs = block.timestamp;

  // Tokens that left the wallet: ours if one of our signed burns has a receipt.
  for (let i = active.length - 1; i >= 0; i--) {
    if (mine(owners[i])) continue;
    const t = active.splice(i, 1)[0];
    let burned = null;
    for (const s of sent.filter((x) => x.id === t.id)) {
      const r = await provider.getTransactionReceipt(s.hash);
      if (!r) continue;
      const claimed = r.logs.map((l) => { try { return poolIface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Claimed');
      burned = { hash: s.hash, amount: claimed?.args.amount ?? 0n, block: r.blockNumber };
      break;
    }
    if (burned) log(`BURNED #${t.id} for ${eth(burned.amount)} ETH${usdOf(burned.amount)} in block ${burned.block}: https://etherscan.io/tx/${burned.hash}`);
    else log(`#${t.id} left the wallet without our burn (owner now ${owners[i] ?? 'none'})`);
  }
  if (!active.length) return;

  const targets = active.map((t) => ({ ...t, minWei: t.eth ?? usdToWei(t.usd, price) }));
  const t = pickToken(targets, pot);
  const data = burnCalldata(me, t.id, t.minWei);
  const status = `block ${n} | pot ${eth(pot)} ETH${usdOf(pot)} | #${t.id} needs ${eth(t.minWei)}${targets.length > 1 ? ` | ${targets.length - 1} more waiting` : ''}`;

  if (DRY) {
    let outcome = 'would BURN now';
    try { await provider.call({ from: me, to: NFT, data, blockTag: n }); }
    catch (e) { outcome = `would not burn: ${revertName(e.data) ?? e.shortMessage ?? e.message}`; }
    return log(`${status} | ${outcome}`);
  }

  const raw = await signer.signTransaction({
    type: 2, chainId: 1n, nonce, to: NFT, data, value: 0n, gasLimit: cfg.gasLimit,
    maxPriorityFeePerGas: cfg.priority, maxFeePerGas: block.baseFeePerGas * 2n + cfg.priority,
  });
  sent.push({ hash: Transaction.from(raw).hash, block: n, id: t.id });
  while (sent.length && sent[0].block < n - 5) sent.shift();
  const [a, b] = await Promise.all([sendBundle(raw, n + 1), sendBundle(raw, n + 2)]);
  log(`${status} | ${pot >= t.minWei ? 'FIRING' : 'standing order'} -> ${Math.max(a, b)}/${cfg.builders.length} builders`);
}

process.on('SIGINT', () => { log('stopped'); process.exit(0); });
while (active.length) {
  if (reloadWanted) await reload();
  const n = await provider.getBlockNumber().catch(() => lastBlock);
  if (n <= lastBlock) {
    // Poll fast only around the moment the next block is due; idle politely in between.
    const dueIn = lastTs ? lastTs + SLOT_SECS - Date.now() / 1000 : 0;
    await sleep(dueIn > 1.5 ? 1000 : 100);
    continue;
  }
  lastBlock = n;
  try { await onBlock(n); }
  catch {
    // Load-balanced public RPCs sometimes answer for a block one of their nodes hasn't seen yet.
    await sleep(300);
    try { await onBlock(n); }
    catch (e) { log(`block ${n}: ${e.shortMessage ?? e.message}`); }
  }
}
log('every token burned, done');
