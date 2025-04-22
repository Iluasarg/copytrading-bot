import {
  Connection,
  PublicKey,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { Bundle } from './types';
import { JITO_TIPS, connection, wsol } from "../constants";
import { logger } from "../logger";

// Mock SearcherClient class for compilation purposes
class SearcherClient {
  constructor(url: string) {}

  async getTipAccounts(): Promise<string[]> {
    return ["mock-tip-account"];
  }

  async sendBundle(bundle: Bundle): Promise<string> {
    return "mock-uuid";
  }
}

export const createSearcherClient = () => {
  const blockEngineUrl = process.env.BLOCK_ENGINE_URL || '';
  if (!blockEngineUrl) {
    throw new Error(
        "BLOCK_ENGINE_URL is not set. Please set it in your .env file (e.g., BLOCK_ENGINE_URL=https://amsterdam.mainnet.block-engine.jito.wtf)"
    );
  }
  logger.info(`BLOCK_ENGINE_URL: ${blockEngineUrl}`);
  return new SearcherClient(blockEngineUrl);
};

export async function sendBundle(
    isSell: boolean,
    latestBlockhash: string,
    transaction: VersionedTransaction,
    poolId: PublicKey,
    masterKeypair: Keypair
): Promise<string> {
  try {
    const searcher_bot = createSearcherClient();

    const tipAccounts = await searcher_bot.getTipAccounts();
    const _tipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
    const tipAccount = new PublicKey(_tipAccount);

    const b: Bundle = new Bundle([transaction], 4);
    let jito_tips = 0.0001;
    b.addTipTx(
        masterKeypair,
        jito_tips * LAMPORTS_PER_SOL,
        tipAccount,
        latestBlockhash
    );

    logger.info({ status: `sending bundle.` });

    const uuid = await searcher_bot.sendBundle(b);
    logger.info({
      dexscreener: `https://dexscreener.com/solana/${poolId.toBase58()}?maker=${masterKeypair.publicKey.toBase58()}`
    });

    return uuid || "";
  } catch (error) {
    logger.error(`error sending bundle: ${error}`);
    return "";
  }
}