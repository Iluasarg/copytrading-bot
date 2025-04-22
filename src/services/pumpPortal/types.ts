import { Keypair, PublicKey } from '@solana/web3.js';

export interface PumpPortalState {
    connection: any;
    owner: Keypair;
    tokenBalances: { [mint: string]: { bought: number; sold: number; costInSol: number; revenueInSol: number } };
    sourceTokenBalances: { [mint: string]: { bought: number; sold: number } };
}