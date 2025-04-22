import axios from 'axios';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';

const JUPITER_QUOTE_API = 'https://quote-api.jup.ag/v6/quote';
const JUPITER_SWAP_API = 'https://quote-api.jup.ag/v6/swap';

export interface QuoteResponse {
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    priceImpactPc: number;
    routePlan: {
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
        percent: number;
    }[];
}

export interface PumpSwapPoolInfo {
    poolAddress: PublicKey;
    inAmount: bigint;
    outAmount: bigint;
}

export class JupiterSDK {
    private connection: Connection;
    private owner: Keypair;

    constructor(connection: Connection, owner: Keypair) {
        this.connection = connection;
        this.owner = owner;
    }

    async getPumpSwapPool(
        inputMint: PublicKey,
        outputMint: PublicKey,
        amount: bigint,
        slippageBps: number
    ): Promise<{ poolInfo: PumpSwapPoolInfo | null; quote: QuoteResponse | null }> {
        try {
            const response = await axios.get(JUPITER_QUOTE_API, {
                params: {
                    inputMint: inputMint.toBase58(),
                    outputMint: outputMint.toBase58(),
                    amount: amount.toString(),
                    slippageBps: Math.floor(slippageBps * 100),
                },
            });

            const quote: QuoteResponse = response.data;
            console.log(`Котировка от Jupiter: ${quote.inAmount} ${inputMint.toBase58()} -> ${quote.outAmount} ${outputMint.toBase58()}`);

            for (const route of quote.routePlan) {
                const swapInfo = route.swapInfo;
                if (swapInfo.label === 'PumpSwap' || swapInfo.ammKey === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') {
                    return {
                        poolInfo: {
                            poolAddress: new PublicKey(swapInfo.ammKey),
                            inAmount: BigInt(swapInfo.inAmount),
                            outAmount: BigInt(swapInfo.outAmount),
                        },
                        quote,
                    };
                }
            }

            console.log('Пул PumpSwap не найден в маршруте Jupiter');
            return { poolInfo: null, quote };
        } catch (error) {
            if (axios.isAxiosError(error)) {
                console.error(`Ошибка получения котировки от Jupiter: ${error.message}, статус: ${error.response?.status}, данные: ${JSON.stringify(error.response?.data)}`);
            } else {
                console.error(`Ошибка получения котировки от Jupiter: ${error}`);
            }
            return { poolInfo: null, quote: null };
        }
    }

    async executeSwap(quote: QuoteResponse): Promise<string | null> {
        try {
            const response = await axios.post(JUPITER_SWAP_API, {
                quoteResponse: quote,
                userPublicKey: this.owner.publicKey.toBase58(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: 100_000,
            });

            const transaction = VersionedTransaction.deserialize(Buffer.from(response.data.swapTransaction, 'base64'));
            transaction.sign([this.owner]);

            const txId = await this.connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: 'confirmed', maxRetries: 3 });
            const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
            await this.connection.confirmTransaction(
                {
                    signature: txId,
                    blockhash: latestBlockhash.blockhash,
                    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
                },
                'confirmed'
            );

            return txId;
        } catch (error) {
            console.error(`Ошибка выполнения свопа через Jupiter: ${error}`);
            return null;
        }
    }
}