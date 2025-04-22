import { Keypair, PublicKey } from '@solana/web3.js';

export interface RaydiumState {
    connection: any;
    httpConnection: any;
    owner: Keypair;
    tokenBalances: { [mint: string]: { bought: number; sold: number } };
    sourceTokenBalances: { [mint: string]: { bought: number; sold: number } };
}