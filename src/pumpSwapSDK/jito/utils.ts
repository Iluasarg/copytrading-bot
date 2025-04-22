import { Bundle } from './types';
import { logger } from '../logger';
import { VersionedTransaction } from '@solana/web3.js';
import { Meta, Packet } from './packet';
import { writeLineToLogFile } from "../utils";

// Mock SearcherClient class for compilation purposes
class SearcherClient {
    constructor(url: string) {}

    onBundleResult(
        onResult: (result: BundleResult) => void,
        onError: (error: Error) => void
    ): void {
        // Mock implementation
    }
}

interface BundleResult {
    bundleId: string;
    status: string;
}

export async function onBundleResult(c: SearcherClient): Promise<void> {
    return new Promise((resolve) => {
        c.onBundleResult(
            (result: BundleResult) => {
                logger.info(`received bundle result: ${JSON.stringify(result)}`);
                console.log(result);
                resolve();
            },
            (e: Error) => {
                logger.error(`received error ${e.message} when listening the bundle result`);
                resolve();
            }
        );
    });
}

export const serializeTransactions = (txs: VersionedTransaction[]): Packet[] => {
    return txs.map(tx => {
        const data = tx.serialize();
        return {
            data,
            meta: {
                port: 0,
                addr: '0.0.0.0',
                senderStake: 0,
                size: data.length,
                flags: undefined,
            } as Meta,
        } as Packet;
    });
};