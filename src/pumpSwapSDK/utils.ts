import { Logger } from 'pino';
import fs from "fs";
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  GetProgramAccountsFilter,
  ParsedAccountData,
} from '@solana/web3.js';
import { logger } from './logger';
import bs58 from 'bs58';
import {connection} from "./constants";
import dotenv from 'dotenv';
import * as path from 'path';

const relativeDotenvPath = "../../.env";
const absoluteDotenvPath = path.resolve(__dirname, relativeDotenvPath);
dotenv.config({ path: absoluteDotenvPath });

const log_path = "";
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export async function getSPLTokenBalance(connection: Connection, tokenAccount: PublicKey, payerPubKey: PublicKey): Promise<number> {
  try {
    const address = getAssociatedTokenAddressSync(tokenAccount, payerPubKey);
    const info = await connection.getTokenAccountBalance(address, "processed");
    if (info.value.uiAmount == null) throw new Error("No balance found");
    return info.value.uiAmount;
  } catch (err: any) {
    logger.error(`Error when checking token balance...`);
    return 0;
  }
}

export function retrieveEnvVariable(variableName: string, logger: Logger): string {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
}

export function getKeypairByJsonPath(jsonPath: string): Keypair | undefined {
  try {
    const keypairJson = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(keypairJson);
    return Keypair.fromSecretKey(Uint8Array.from(data));
  } catch (e) {
    console.log(e);
    return undefined;
  }
}

export async function printSOLBalance(connection: Connection, pubKey: PublicKey, info: string = ""): Promise<void> {
  const balance = await connection.getBalance(pubKey);
  console.log(
      `${info ? info + " " : ""}${pubKey.toBase58()}:`,
      balance / LAMPORTS_PER_SOL,
      `SOL`
  );
}

export async function getSOLBalance(connection: Connection, pubKey: PublicKey): Promise<number> {
  const balance = await connection.getBalance(pubKey);
  return balance / LAMPORTS_PER_SOL;
}

export async function getSPLBalance(connection: Connection, mintAddress: PublicKey, pubKey: PublicKey, allowOffCurve: boolean = false): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mintAddress, pubKey, allowOffCurve);
    const balance = await connection.getTokenAccountBalance(ata, "confirmed");
    return balance.value.uiAmount || 0;
  } catch (e) {
    return 0;
  }
}

export async function printSPLBalance(connection: Connection, mintAddress: PublicKey, user: PublicKey, info: string = ""): Promise<void> {
  const balance = await getSPLBalance(connection, mintAddress, user);
  if (balance === 0) {
    console.log(
        `${info ? info + " " : ""}${user.toBase58()}:`,
        "No Account Found"
    );
  } else {
    console.log(`${info ? info + " " : ""}${user.toBase58()}:`, balance);
  }
}

interface ParsedTokenAccount {
  account: {
    data: ParsedAccountData & {
      parsed: {
        info: {
          mint: string;
          tokenAmount: { uiAmount: number };
        };
      };
    };
  };
}

interface WalletState {
  [mint: string]: number;
}

export async function retriveWalletState(wallet_address: string): Promise<WalletState> {
  try {
    const filters: GetProgramAccountsFilter[] = [
      { dataSize: 165 },
      { memcmp: { offset: 32, bytes: wallet_address } },
    ];
    const accounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, { filters }) as ParsedTokenAccount[];
    const results: WalletState = {};
    const solBalance = await connection.getBalance(new PublicKey(wallet_address));
    accounts.forEach((account) => {
      const parsedAccountInfo = account.account.data.parsed;
      const mintAddress = parsedAccountInfo.info.mint;
      const tokenBalance = parsedAccountInfo.info.tokenAmount.uiAmount;
      results[mintAddress] = tokenBalance;
    });
    results["SOL"] = solBalance / 10 ** 9;
    return results;
  } catch (e) {
    console.log(e);
    return {};
  }
}

export async function getDecimals(mintAddress: PublicKey): Promise<number> {
  const info = await connection.getParsedAccountInfo(mintAddress);
  const result = (info.value?.data as ParsedAccountData)?.parsed?.info?.decimals || 0;
  return result;
}

export async function writeLineToLogFile(logMessage: string): Promise<void> {
  fs.appendFile(log_path, `${logMessage}\n`, (err) => {
    if (err) {
      console.error('Error writing to log file:', err);
    }
  });
}