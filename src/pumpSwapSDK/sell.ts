import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { connection, wallet_1 } from './constants';
import { PumpSwapSDK } from './pumpswap';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

async function sell_example() {
  const pumpswap_sdk = new PumpSwapSDK(connection as Connection, wallet_1 as Keypair);
  const pool = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
  const tokenMint = new PublicKey("So11111111111111111111111111111111111111112"); // SOL mint as an example
  const tokenAccounts = await connection.getTokenAccountsByOwner(
      (wallet_1 as Keypair).publicKey,
      { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") }
  );
  const tokenAccount = tokenAccounts.value[0]?.pubkey;
  if (!tokenAccount) throw new Error("Token account not found");
  const tokenBalance = await connection.getTokenAccountBalance(tokenAccount);
  const amount = BigInt(tokenBalance.value.amount);

  // Create sell instruction
  const sellInstruction = await pumpswap_sdk.createSellInstruction(
      pool,
      tokenMint,
      amount,
      wallet_1 as Keypair,
      1.0 // Slippage
  );

  // Build and send transaction
  const transaction = new Transaction();
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = (wallet_1 as Keypair).publicKey;
  transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      sellInstruction
  );

  const signature = await connection.sendTransaction(transaction, [wallet_1 as Keypair], { skipPreflight: false, maxRetries: 5 });
  console.log(`Sell transaction sent: ${signature}`);
}

sell_example();