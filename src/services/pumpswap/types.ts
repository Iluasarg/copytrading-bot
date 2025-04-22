import { PublicKey } from '@solana/web3.js';

export interface TokenBalance {
    bought: number;
    sold: number;
}

export interface TokenAmount {
    balance: number;
    decimals: number;
    amount: bigint;
}

export interface PumpSwapPoolInfo {
    poolAddress: PublicKey;
    inAmount: bigint;
    outAmount: bigint;
}

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