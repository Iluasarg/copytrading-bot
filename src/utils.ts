import chalk from 'chalk';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';

export const log = {
    info: (data: { event: string; message: string }) => {
        const time = new Date().toISOString().slice(11, 19);
        console.log(`${chalk.gray(time)} [${chalk.blue(data.event)}] ${data.message}`);
    },
    warn: (data: { event: string; message: string }) => {
        const time = new Date().toISOString().slice(11, 19);
        console.log(`${chalk.gray(time)} [${chalk.yellow(data.event)}] ${data.message}`);
    },
    error: (data: { event: string; message: string }) => {
        const time = new Date().toISOString().slice(11, 19);
        console.log(`${chalk.gray(time)} [${chalk.red(data.event)}] ${data.message}`);
    },
    success: (data: { event?: string; message: string }) => {
        const time = new Date().toISOString().slice(11, 19);
        const event = data.event || 'confirmed';
        console.log(`${chalk.gray(time)} [${chalk.green(event)}] ${data.message}`);
    },
};

export const sleep = (ms: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

export const checkTransactionStatus = async (connection: Connection, signature: string): Promise<boolean> => {
    const status = await connection.getSignatureStatus(signature);
    const confirmation = status.value?.confirmationStatus;
    return confirmation === 'confirmed' || confirmation === 'finalized';
};

export const getTokenBalance = async (connection: Connection, owner: PublicKey, mint: PublicKey): Promise<{ balance: number; decimals: number; amount: bigint }> => {
    const ata = await connection.getTokenAccountsByOwner(owner, { mint, programId: TOKEN_PROGRAM_ID });
    if (ata.value.length === 0) {
        const decimals = await getTokenDecimals(connection, mint);
        return { balance: 0, decimals, amount: BigInt(0) };
    }
    const accountInfo = await connection.getTokenAccountBalance(ata.value[0].pubkey);
    const decimals = accountInfo.value.decimals;
    const amount = BigInt(accountInfo.value.amount);
    const balance = Number(amount) / Math.pow(10, decimals);
    return { balance, decimals, amount };
};

export const checkSolBalance = async (connection: Connection, owner: PublicKey): Promise<number> => {
    const balance = await connection.getBalance(owner);
    return balance / 1_000_000_000;
};

export const getTokenDecimals = async (connection: Connection, mint: PublicKey): Promise<number> => {
    const mintInfo = await getMint(connection, mint);
    return mintInfo.decimals;
};