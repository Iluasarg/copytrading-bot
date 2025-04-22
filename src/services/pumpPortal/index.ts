import * as dotenv from 'dotenv';
import WebSocket from 'ws';
import axios from 'axios';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { CONFIG, PUMP_PORTAL_SOURCE_WALLET, PUMP_PORTAL_TARGET_WALLET } from '../../config';
import { log, sleep, getTokenBalance } from '../../utils';
import { PumpPortalState } from './types';

dotenv.config();

// Initialize Solana connection and owner
const connection = new Connection(CONFIG.PUMP_PORTAL_RPC_URL, 'confirmed');
const owner = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));

// State
const state: PumpPortalState = {
    connection,
    owner,
    tokenBalances: {},
    sourceTokenBalances: {},
};
const processedSignatures = new Set<string>();

// Send Telegram message
async function sendTelegramMessage(message: string): Promise<void> {
    try {
        const url = ` FELIX https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: CONFIG.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
        });
        log.success({ event: 'telegram_message_sent', message: 'Telegram message sent successfully' });
    } catch (error: unknown) {
        log.error({ event: 'telegram_message_error', message: `Error sending Telegram message: ${(error as Error).message}` });
    }
}

// Execute Pumpfun swap
export async function executePumpfunSwap(
    action: 'buy' | 'sell',
    mint: string,
    amount: number,
    denominatedInSol: boolean
): Promise<{ signature: string | null; solAmount?: number }> {
    const payload = {
        publicKey: PUMP_PORTAL_TARGET_WALLET.toBase58(),
        action,
        mint,
        denominatedInSol: denominatedInSol.toString(),
        amount: amount.toString(),
        slippage: CONFIG.PUMP_PORTAL_DEFAULT_SLIPPAGE,
        priorityFee: CONFIG.PUMP_PORTAL_PRIORITY_FEE,
        tradeType: 'exactIn',
    };

    try {
        const response = await axios.post(`${CONFIG.PUMP_TRADE_API_URL}?api-key=${CONFIG.PUMP_PORTAL_API_KEY}`, payload);
        log.info({ event: 'pumpfun_swap_response', message: `HTTP status: ${response.status}` });

        if (response.status === 200 && response.data.signature) {
            const signature = response.data.signature;
            const solAmount = response.data.sol_amount ? parseFloat(response.data.sol_amount) : undefined;
            log.success({ event: 'pumpfun_swap_success', message: `Pumpfun transaction sent: https://solscan.io/tx/${signature}` });

            let message: string;
            if (action === 'buy') {
                if (!state.tokenBalances[mint]) {
                    state.tokenBalances[mint] = { bought: 0, sold: 0, costInSol: 0, revenueInSol: 0 };
                }
                message = `🟢 <b>Buy (PumpFun)</b>\nToken: ${mint}\nAmount: ${amount.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${signature}`;
                state.tokenBalances[mint].costInSol += amount;
                log.info({ event: 'pumpfun_buy_cost_updated', message: `Updated costInSol for ${mint}: ${state.tokenBalances[mint].costInSol}` });
            } else {
                if (!state.tokenBalances[mint]) {
                    state.tokenBalances[mint] = { bought: 0, sold: 0, costInSol: 0, revenueInSol: 0 };
                }
                let profitLoss = 0;
                if (solAmount && state.tokenBalances[mint].bought > 0) {
                    const costPerToken = state.tokenBalances[mint].costInSol / state.tokenBalances[mint].bought;
                    const soldCost = costPerToken * amount;
                    profitLoss = solAmount - soldCost;
                    state.tokenBalances[mint].revenueInSol += solAmount;
                }
                message = `🔴 <b>Sell (PumpFun)</b>\nToken: ${mint}\nAmount: ${amount.toFixed(4)} tokens\nReceived: ${solAmount ? solAmount.toFixed(4) : 'unknown'} SOL\nP/L: ${profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${signature}`;
            }
            await sendTelegramMessage(message);

            return { signature, solAmount };
        } else {
            log.warn({ event: 'pumpfun_swap_no_signature', message: 'Transaction signature not found in response or API error' });
            return { signature: null };
        }
    } catch (error: unknown) {
        log.error({ event: 'pumpfun_swap_error', message: `Error executing Pumpfun swap: ${(error as Error).message}` });
        return { signature: null };
    }
}

// Execute Raydium swap
async function executeRaydiumSwap(
    inputMint: string,
    outputMint: string,
    amount: string
): Promise<{ signature: string | null; solAmount?: number }> {
    try {
        const swapResponse = await axios.get(`${CONFIG.RAYDIUM_SWAP_HOST}/compute/swap-base-in`, {
            params: { inputMint, outputMint, amount, slippageBps: CONFIG.RAYDIUM_SLIPPAGE * 100, txVersion: 'V0' },
        });
        const swapData = swapResponse.data;
        log.info({ event: 'raydium_swap_quote', message: `Quote received for ${inputMint} -> ${outputMint}` });

        const txResponse = await axios.post(`${CONFIG.RAYDIUM_SWAP_HOST}/transaction/swap-base-in`, {
            computeUnitPriceMicroLamports: CONFIG.RAYDIUM_PRIORITY_FEE,
            wallet: CONFIG.RAYDIUM_TARGET_WALLET,
            ...swapData.data,
        });
        const txData = txResponse.data;

        const transaction = VersionedTransaction.deserialize(Buffer.from(txData.transaction, 'base64'));
        transaction.sign([owner]);
        const txid = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true, maxRetries: 5 });
        await connection.confirmTransaction(txid, 'confirmed');
        log.success({ event: 'raydium_swap_success', message: `Raydium swap executed: https://solscan.io/tx/${txid}` });

        const isBuy = inputMint === CONFIG.SOL_MINT;
        const mint = isBuy ? outputMint : inputMint;
        const solAmount = isBuy ? parseFloat(amount) / 1e9 : parseFloat(swapData.data.amountOut) / 1e9;

        let message: string;
        if (isBuy) {
            if (!state.tokenBalances[mint]) {
                state.tokenBalances[mint] = { bought: 0, sold: 0, costInSol: 0, revenueInSol: 0 };
            }
            message = `🟢 <b>Buy (Raydium)</b>\nToken: ${mint}\nAmount: ${solAmount.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${txid}`;
            state.tokenBalances[mint].costInSol += solAmount;
            log.info({ event: 'raydium_buy_cost_updated', message: `Updated costInSol for ${mint}: ${state.tokenBalances[mint].costInSol}` });
        } else {
            if (!state.tokenBalances[mint]) {
                state.tokenBalances[mint] = { bought: 0, sold: 0, costInSol: 0, revenueInSol: 0 };
            }
            const tokenAmount = parseFloat(amount) / 1e6;
            const costPerToken = state.tokenBalances[mint].bought > 0 ? state.tokenBalances[mint].costInSol / state.tokenBalances[mint].bought : 0;
            const soldCost = costPerToken * tokenAmount;
            const profitLoss = solAmount - soldCost;
            state.tokenBalances[mint].revenueInSol += solAmount;
            message = `🔴 <b>Sell (Raydium)</b>\nToken: ${mint}\nAmount: ${tokenAmount.toFixed(4)} tokens\nReceived: ${solAmount.toFixed(4)} SOL\nP/L: ${profitLoss >= 0 ? '+' : ''}${profitLoss.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${txid}`;
        }
        await sendTelegramMessage(message);

        return { signature: txid, solAmount };
    } catch (error: unknown) {
        log.error({ event: 'raydium_swap_error', message: `Error executing Raydium swap: ${(error as Error).message}` });
        return { signature: null };
    }
}

// Handle WebSocket messages
async function handleWebSocketMessage(data: any) {
    const signature = data.signature;
    if (processedSignatures.has(signature)) {
        log.warn({ event: 'transaction_already_processed', message: `Transaction ${signature} already processed, skipping` });
        return;
    }

    if (data.traderPublicKey === PUMP_PORTAL_SOURCE_WALLET.toBase58()) {
        const txType = data.txType;
        const mint = data.mint;
        const tokenAmount = parseFloat(data.tokenAmount);
        const solAmount = parseFloat(data.solAmount);
        const pool = data.pool || 'pump';

        log.info({ event: 'transaction_detected', message: `Detected transaction: ${txType} ${tokenAmount} tokens for ${solAmount} SOL for ${mint} (pool: ${pool})` });

        if (!state.tokenBalances[mint]) state.tokenBalances[mint] = { bought: 0, sold: 0, costInSol: 0, revenueInSol: 0 };
        if (!state.sourceTokenBalances[mint]) state.sourceTokenBalances[mint] = { bought: 0, sold: 0 };

        if (txType === 'buy') {
            state.sourceTokenBalances[mint].bought += tokenAmount;
            log.info({ event: 'source_token_balances_updated_buy', message: `Updated sourceTokenBalances for ${mint}: ${state.sourceTokenBalances[mint].bought}` });

            const targetSolAmount = solAmount * CONFIG.PUMP_PORTAL_TRADE_PERCENTAGE;
            log.info({ event: 'buy_trade_amount', message: `Buying at ${CONFIG.PUMP_PORTAL_TRADE_PERCENTAGE * 100}% of amount: ${targetSolAmount} SOL` });

            const result = pool === 'pump'
                ? await executePumpfunSwap('buy', mint, targetSolAmount, true)
                : await executeRaydiumSwap(CONFIG.SOL_MINT, mint, (targetSolAmount * 1e9).toString());

            if (result.signature) {
                await sleep(2000);
                const { balance: realBalance } = await getTokenBalance(connection, PUMP_PORTAL_TARGET_WALLET, new PublicKey(mint));
                state.tokenBalances[mint].bought = realBalance > 0 ? realBalance : tokenAmount * CONFIG.PUMP_PORTAL_TRADE_PERCENTAGE;
                if (realBalance === 0) log.warn({ event: 'token_balance_assumed', message: `Failed to fetch real balance, assuming: ${state.tokenBalances[mint].bought}` });
                log.success({ event: 'token_balances_updated_buy', message: `Updated tokenBalances for ${mint}: ${state.tokenBalances[mint].bought}` });
            }
        } else if (txType === 'sell') {
            state.sourceTokenBalances[mint].sold += tokenAmount;
            log.info({ event: 'source_token_balances_updated_sell', message: `Updated sourceTokenBalances for ${mint}: ${state.sourceTokenBalances[mint].sold}` });

            const sourceInitialBought = state.sourceTokenBalances[mint].bought;
            const sourceSold = state.sourceTokenBalances[mint].sold;
            const targetSold = state.tokenBalances[mint].sold;
            const sellPercentage = sourceSold / sourceInitialBought || 0;
            log.info({ event: 'sell_percentage_check', message: `SOURCE_WALLET sell percentage: ${(sellPercentage * 100).toFixed(2)}%` });

            const { balance: realBalance } = await getTokenBalance(connection, PUMP_PORTAL_TARGET_WALLET, new PublicKey(mint));
            const targetRemaining = realBalance - targetSold;
            if (targetRemaining <= CONFIG.MIN_TOKEN_THRESHOLD) {
                log.warn({ event: 'insufficient_balance', message: `TARGET_WALLET has insufficient tokens ${mint} to sell (real balance: ${realBalance})` });
                return;
            }

            let targetTokenAmount;
            if (sellPercentage >= 1.0) {
                targetTokenAmount = targetRemaining;
                log.info({ event: 'sell_amount_calculated', message: `SOURCE_WALLET sold 100%, selling all: ${targetTokenAmount} tokens` });
            } else {
                targetTokenAmount = targetRemaining * sellPercentage * CONFIG.PUMP_PORTAL_TRADE_PERCENTAGE;
                log.info({ event: 'sell_amount_calculated', message: `Selling ${targetTokenAmount} tokens (proportional to ${CONFIG.PUMP_PORTAL_TRADE_PERCENTAGE * 100}% of ${sellPercentage * 100}%)` });
            }

            const result = pool === 'pump'
                ? await executePumpfunSwap('sell', mint, targetTokenAmount, false)
                : await executeRaydiumSwap(mint, CONFIG.SOL_MINT, (targetTokenAmount * 1e6).toString());

            if (result.signature) {
                state.tokenBalances[mint].sold += targetTokenAmount;
                const { balance: updatedBalance } = await getTokenBalance(connection, PUMP_PORTAL_TARGET_WALLET, new PublicKey(mint));
                log.success({ event: 'token_balances_updated_sell', message: `Updated tokenBalances for ${mint}: sold ${state.tokenBalances[mint].sold}, remaining: ${updatedBalance}` });
            }
        }
        processedSignatures.add(signature);
    } else {
        log.info({ event: 'wrong_wallet', message: `Wallet does not match: ${data.traderPublicKey}` });
    }
}

// Start WebSocket
function startWebSocket() {
    const ws = new WebSocket(CONFIG.PUMP_PORTAL_WEBSOCKET_URL);

    ws.on('open', () => {
        log.success({ message: `Connected to PumpPortal WebSocket` });
        ws.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: [PUMP_PORTAL_SOURCE_WALLET.toBase58()] }));
        log.info({ event: 'websocket_subscription', message: `Subscribed to ${PUMP_PORTAL_SOURCE_WALLET.toBase58()}` });
    });

    ws.on('message', async (data: string) => {
        const message = JSON.parse(data);
        log.info({ event: 'websocket_message', message: `Received WebSocket message: ${JSON.stringify(message)}` });
        await handleWebSocketMessage(message);
    });

    ws.on('error', (error: Error) => log.error({ event: 'websocket_error', message: `WebSocket error: ${error.message}` }));
    ws.on('close', () => log.warn({ event: 'websocket_closed', message: `WebSocket connection closed` }));
}

// Start application
log.info({ event: 'script_start', message: `Starting script, time: ${Math.floor(Date.now() / 1000)}` });
log.info({ event: 'service_init', message: `Monitoring ${PUMP_PORTAL_SOURCE_WALLET.toBase58()} for copying to ${PUMP_PORTAL_TARGET_WALLET.toBase58()}` });
startWebSocket();