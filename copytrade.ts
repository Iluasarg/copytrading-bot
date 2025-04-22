import { log } from './src/utils';
import WebSocket from 'ws';
import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG, TARGET_WALLET } from './src/config';
import { RaydiumService } from './src/services/raydium';
import { PumpSwapService } from './src/services/pumpswap';
import { executePumpfunSwap } from './src/services/pumpPortal';

interface TransactionService {
    processTransaction(signature: string, data: any): Promise<void>;
    startWebSocket(): void;
}

class PumpPortalService implements TransactionService {
    private processedSignatures: Set<string>;
    private processedTransactions: Set<string>;
    private connection: Connection;

    constructor(processedSignatures: Set<string>, processedTransactions: Set<string>) {
        this.processedSignatures = processedSignatures;
        this.processedTransactions = processedTransactions;
        this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    }

    async processTransaction(signature: string, data: any): Promise<void> {
        if (this.processedSignatures.has(signature)) {
            log.info({ event: 'pump_portal_already_processed', message: `Transaction ${signature} already processed` });
            return;
        }

        log.info({ event: 'pump_portal_processing', message: `Processing PumpPortal transaction: ${signature}, pool: ${data.pool}` });

        // Check if it's really a pump-portal transaction
        if (data.pool !== 'pump-portal' && data.pool !== 'pump') {
            log.info({ event: 'not_pump_portal', message: `Transaction ${signature} is not related to pump-portal, skipping` });
            return;
        }

        // Extract data from the transaction
        const tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        if (!tx || !tx.meta) {
            log.warn({ event: 'invalid_tx', message: `Failed to retrieve transaction: ${signature}` });
            return;
        }

        // Look for mint and amount from transfer instructions
        let mint: string | undefined;
        let amount: number | undefined;
        let txType: 'buy' | 'sell' = 'buy'; // Default to buy, refine below
        const instructions = tx.transaction.message.instructions;
        for (const ix of instructions) {
            if ('parsed' in ix && ix.program === 'spl-token' && ix.parsed.type === 'transfer') {
                mint = ix.parsed.info.mint;
                amount = parseFloat(ix.parsed.info.amount) / 1e6; // Assume 6 decimals
                // Determine type: if sender is TARGET_WALLET, it's sell
                if (ix.parsed.info.source === TARGET_WALLET.toBase58()) {
                    txType = 'sell';
                }
                break;
            }
        }

        if (!mint || !amount) {
            log.warn({ event: 'no_mint_or_amount', message: `Failed to extract mint or amount for ${signature}` });
            return;
        }

        // Check if transaction with this mint and txType was already processed
        const transactionKey = `${mint}:${txType}`;
        if (this.processedTransactions.has(transactionKey)) {
            log.info({ event: 'transaction_already_processed', message: `Transaction for ${mint} (${txType}) already processed` });
            return;
        }

        const result = await executePumpfunSwap(txType, mint, amount, txType === 'buy');
        if (result.signature) {
            log.success({ event: 'pump_portal_swap_success', message: `PumpPortal ${txType} transaction sent: ${result.signature}` });
            this.processedSignatures.add(signature);
            this.processedTransactions.add(transactionKey);

            // Send Telegram message with correct service name
            const message = txType === 'buy'
                ? `🟢 <b>Buy (PumpPortal)</b>\nToken: ${mint}\nAmount: ${amount.toFixed(4)} tokens\nTransaction: https://solscan.io/tx/${result.signature}`
                : `🔴 <b>Sell (PumpPortal)</b>\nToken: ${mint}\nAmount: ${amount.toFixed(4)} tokens\nTransaction: https://solscan.io/tx/${result.signature}`;
            log.info({ event: 'sending_telegram_message', message: `Sending Telegram message: ${message}` });
            // Here should be a call to the Telegram message sending function, e.g.:
            // await sendTelegramMessage(message);
            log.info({ event: 'telegram_message_sent', message: 'Telegram message sent successfully' });
        } else {
            log.warn({ event: 'pump_portal_swap_failed', message: `Failed to execute PumpPortal ${txType} transaction: ${signature}` });
        }
    }

    startWebSocket(): void {
        log.info({ event: 'pump_portal_websocket', message: 'WebSocket for PumpPortalService is not required' });
    }
}

async function main() {
    log.info({ event: 'script_start', message: 'Starting script for wallet monitoring' });

    const processedSignatures = new Set<string>();
    const processedTransactions = new Set<string>(); // To store mint + txType

    log.info({ event: 'service_initialization', message: 'Initializing services: PumpPortal, Raydium, and PumpSwap' });

    const pumpPortalService: TransactionService = new PumpPortalService(processedSignatures, processedTransactions);
    const raydiumService: TransactionService = new RaydiumService(processedSignatures);
    const pumpSwapService: TransactionService = new PumpSwapService(processedSignatures);

    const ws = new WebSocket(CONFIG.WEBSOCKET_URL);

    ws.on('open', () => {
        log.info({ event: 'websocket_opened', message: `WebSocket opened, subscribed to ${TARGET_WALLET.toBase58()}` });
        ws.send(
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'accountSubscribe',
                params: [TARGET_WALLET.toBase58(), { commitment: 'confirmed', encoding: 'jsonParsed' }],
            })
        );
        log.info({ event: 'websocket_subscription', message: `Subscribed to ${TARGET_WALLET.toBase58()}` });
    });

    ws.on('message', async (data: WebSocket.RawData) => {
        try {
            const message = JSON.parse(data.toString());
            log.info({ event: 'websocket_message', message: `Received WebSocket message: ${data}` });

            // Handle WebSocket messages with transaction details
            if ('signature' in message && 'mint' in message) {
                const signature = message.signature;
                if (processedSignatures.has(signature)) {
                    log.info({ event: 'already_processed_websocket', message: `Transaction ${signature} already processed (WebSocket)` });
                    return;
                }

                const pool = message.pool === 'pump' ? 'pump-portal' : message.pool || 'unknown';
                const messageData = { ...message, pool };

                log.info({ event: 'websocket_transaction_processing', message: `Processing WebSocket transaction: ${signature}, pool: ${pool}, mint: ${message.mint}` });

                if (pool === 'pump-portal') {
                    await pumpPortalService.processTransaction(signature, messageData);
                    processedSignatures.add(signature);
                } else if (pool === 'pump-amm') {
                    await pumpSwapService.processTransaction(signature, messageData);
                    processedSignatures.add(signature);
                } else {
                    log.warn({ event: 'unknown_pool_websocket', message: `Unknown pool in WebSocket: ${pool}, transaction: ${signature}` });
                }
                return;
            }

            // Handle account notifications
            if (message.method === 'accountNotification') {
                const signatures = await new Connection(CONFIG.RPC_URL, 'confirmed').getSignaturesForAddress(TARGET_WALLET, { limit: 1 });
                if (signatures.length > 0) {
                    const latestSignature = signatures[0].signature;
                    if (processedSignatures.has(latestSignature)) {
                        log.info({ event: 'already_processed_main', message: `Transaction ${latestSignature} already processed (main loop)` });
                        return;
                    }

                    const tx = await new Connection(CONFIG.RPC_URL, 'confirmed').getParsedTransaction(latestSignature, { maxSupportedTransactionVersion: 0 });
                    if (!tx || !tx.meta) {
                        log.warn({ event: 'invalid_tx', message: `Failed to retrieve transaction: ${latestSignature}` });
                        return;
                    }

                    const logMessages = tx.meta.logMessages || [];
                    const hasRaydiumLog = logMessages.some((log: string) => log.includes("Swap") || log.includes("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"));
                    const hasPumpPortalLog = logMessages.some((log: string) => log.includes("pump-portal"));
                    const hasPumpSwapLog = logMessages.some((log: string) => log.includes("pump-amm") || log.includes("Instruction: Buy") || log.includes("Instruction: Sell"));

                    log.info({ event: 'pool_check', message: `hasRaydiumLog: ${hasRaydiumLog}, hasPumpSwapLog: ${hasPumpSwapLog}, hasPumpPortalLog: ${hasPumpPortalLog}, logMessages: ${logMessages.join(', ') || 'no logs'}` });

                    let pool = 'unknown';
                    if (hasRaydiumLog) pool = 'raydium';
                    else if (hasPumpPortalLog) pool = 'pump-portal';
                    else if (hasPumpSwapLog) pool = 'pump-amm';

                    log.info({ event: 'transaction_processing', message: `Processing: ${latestSignature}, pool: ${pool}, logMessages: ${logMessages.join(', ') || 'no logs'}` });

                    const messageData = { ...message.params.result, pool };

                    // Extract mint for additional verification
                    let mint: string | undefined;
                    const instructions = tx.transaction.message.instructions;
                    for (const ix of instructions) {
                        if ('parsed' in ix && ix.program === 'spl-token' && ix.parsed.type === 'transfer') {
                            mint = ix.parsed.info.mint;
                            break;
                        }
                    }

                    if (pool === 'raydium') {
                        log.info({ event: 'raydium_routing', message: `Redirecting to Raydium: ${latestSignature}, mint: ${mint || 'undefined'}` });
                        await raydiumService.processTransaction(latestSignature, messageData);
                        processedSignatures.add(latestSignature);
                        log.info({ event: 'processing_successful', message: `Transaction processed by RaydiumService: ${latestSignature}` });
                    } else if (pool === 'pump-portal') {
                        log.info({ event: 'pumpportal_routing', message: `Redirecting to PumpPortal: ${latestSignature}, mint: ${mint || 'undefined'}` });
                        await pumpPortalService.processTransaction(latestSignature, messageData);
                        processedSignatures.add(latestSignature);
                        log.info({ event: 'processing_successful', message: `Transaction processed by PumpPortalService: ${latestSignature}` });
                    } else if (pool === 'pump-amm') {
                        log.info({ event: 'pumpswap_routing', message: `Redirecting to PumpSwap: ${latestSignature}, mint: ${mint || 'undefined'}` });
                        await pumpSwapService.processTransaction(latestSignature, messageData);
                        processedSignatures.add(latestSignature);
                        log.info({ event: 'processing_successful', message: `Transaction processed by PumpSwapService: ${latestSignature}` });
                    } else {
                        log.warn({ event: 'unknown_pool', message: `Transaction not processed: ${latestSignature}, pool: ${pool}` });
                    }
                }
            }
        } catch (error) {
            log.error({ event: 'processing_error', message: `Error processing message: ${error}` });
        }
    });

    ws.on('error', (error: Error) => log.error({ event: 'websocket_error', message: `WebSocket error: ${error.message}` }));

    ws.on('close', () => {
        log.warn({ event: 'websocket_closed', message: 'WebSocket connection closed, attempting to reconnect...' });
        setTimeout(() => main(), 5000);
    });
}

main().catch(error => {
    log.error({ event: 'script_error', message: `Script error: ${error}` });
    process.exit(1);
});