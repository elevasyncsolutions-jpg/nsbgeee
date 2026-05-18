# Solana Dream Engine V16 RPC Survival Terminal

Fixes the two urgent problems from V15:

1. Jupiter quote host is updated to `https://api.jup.ag/swap/v1/quote`. The old `quote-api.jup.ag` host can fail with ENOTFOUND.
2. Wallet firehose now has per-wallet 429 backoff so public RPC does not spam errors forever.

For real fast wallet copy trading, use a private Solana RPC URL. Public `api.mainnet-beta.solana.com` will throttle `getSignaturesForAddress`.
