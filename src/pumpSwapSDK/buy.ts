import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { connection, wallet_1 } from './constants';
import { PumpSwapSDK } from './pumpswap';

async function derivePoolAddress(tokenMint: PublicKey, programId: PublicKey): Promise<PublicKey> {
    const [poolAddress] = await PublicKey.findProgramAddress(
        [Buffer.from('bonding-curve'), tokenMint.toBuffer()],
        programId
    );
    return poolAddress;
}

async function buy_example() {
    const pumpswap_sdk = new PumpSwapSDK(connection as Connection, wallet_1 as Keypair);
    const tokenMint = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"); // Исправлен tokenMint
    const programId = new PublicKey("6EF8rrecthR5DkS9UqRuntc2rH2ZrT1rW1ZxN2aNh6L");
    const pool = await derivePoolAddress(tokenMint, programId); // Вычисляем адрес пула
    const amountInLamports = BigInt(Math.floor(0.22 * 1_000_000_000)); // 0.22 SOL in lamports
    console.log(`Покупка через пул: ${pool.toBase58()} для токена: ${tokenMint.toBase58()}`);
    await pumpswap_sdk.buy(pool, amountInLamports, tokenMint, wallet_1 as Keypair, 1.0);
}

buy_example();