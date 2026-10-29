# freedz-burner

Burns your FREEDZ into the FREEDZ Community Vault (FreedzRewardPool `0xa603…d097`, Ethereum) as soon as
the pot is worth `TARGET_USD`, and collects the whole pot in the same transaction.

## How it works

- Every block it reads the pot and Chainlink ETH/USD, and signs
  `FREEDZ.safeTransferFrom(you, pool, tokenId, abi.encode(minReward))` with `minReward` set to your
  target in wei. The pool then refuses any burn below the target, and your NFT stays put.
- The signed tx goes to 5 block builders as a one-tx bundle for the next 2 blocks: BuilderNet
  (Flashbots), Titan, Beaver, Quasar and Lightspeed. Builders drop bundles that would revert. A pot
  below target, or a race lost to another burner, costs **no gas**. The tx is never in the public
  mempool, so nobody can copy it.
- This is a standing order. It re-sends every block and lands in the first block where the pot is at
  least the target. Each token has its own target (`TARGET_ETH` or `TARGET_USD`, one value or one per
  token). Each block it signs for the highest target the pot already meets, or else the lowest one, and
  it exits once every token is burned.
- It polls for new blocks every 100 ms around the moment the next block is due, and every second
  otherwise. With fixed `TARGET_ETH` it makes no price calls at all.
- `npm run reload` (Linux) re-reads the token, target, tip and builder settings from `.env` while the
  key stays unlocked, so no password is needed.

## Setup (Windows, PowerShell)

1. Import the wallet that holds the FREEDZ. Foundry asks for the private key and a password, both hidden:
   `cast wallet import freedz --interactive`
2. `copy .env.example .env`, then set `TARGET_USD`, `TOKEN_IDS` and `KEYSTORE`.
3. Install the dependencies: `npm install`
4. Watch it without sending anything: `npm run dry`
5. Run it live: `npm start` (it asks for the keystore password)

The wallet needs ETH for gas: about 0.0003 ETH per burn at a 3 gwei tip, and only when a burn lands.

## Limits

- It doesn't watch the mempool for incoming sales. The fastest bots burn in the same block as the sale
  that tops up the pot. This one lands in the next block, so a target close to the bots' (about $18 on
  10-29) loses some races to them. Losing costs nothing.
- The free public RPC sometimes errors on a block. Each bundle covers two blocks, so one missed block
  is harmless. Set `RPC_URL` to a private key from Alchemy or Infura for steadier reads.

`npm test` runs the unit tests.
