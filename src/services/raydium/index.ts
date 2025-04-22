import axios from 'axios';
import { Connection, Keypair, PublicKey, VersionedTransaction, Commitment, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import bs58 from 'bs58';
import { CONFIG, SOL_MINT, RAYDIUM_TARGET_WALLET, RAYDIUM_PROGRAM_ID, RAYDIUM_CPMM_PROGRAM_ID, JUPITER_PROGRAM_ID } from '../../config';
import { log, sleep, checkSolBalance } from '../../utils';
import { RaydiumState } from './types';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.join(__dirname, '../../logs');
const MAX_LOG_AGE_DAYS = 7;

interface TradeRecord {
    mint: string;
    buyPriceSol: number;
    buyAmount: number;
    sellPriceSol: number;
    sellAmount: number;
    timestamp: number;
}

export class RaydiumService {
    private state: RaydiumState;
    private processedSignatures: Set<string>;
    private commitment: Commitment = 'confirmed';
    private tradeRecords: Record<string, TradeRecord[]>;

    constructor(processedSignatures: Set<string>) {
        this.state = {
            connection: new Connection(CONFIG.RAYDIUM_RPC_URL, this.commitment),
            httpConnection: new Connection(CONFIG.RAYDIUM_HTTP_RPC_URL, this.commitment),
            owner: Keypair.fromSecretKey(bs58.decode(CONFIG.RAYDIUM_WALLET_PRIVATE_KEY)),
            tokenBalances: {},
            sourceTokenBalances: {},
        };
        this.processedSignatures = processedSignatures;
        this.tradeRecords = {};
        this.cleanupOldLogs();
    }

    private cleanupOldLogs(): void {
        if (!fs.existsSync(LOG_DIR)) return;
        const now = Date.now();
        const maxAgeMs = MAX_LOG_AGE_DAYS * 24 * 60 * 60 * 1000;
        fs.readdirSync(LOG_DIR).forEach(file => {
            const filePath = path.join(LOG_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAgeMs) {
                fs.unlinkSync(filePath);
            }
        });
    }

    private async sendTelegramMessage(message: string): Promise<void> {
        if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
            log.info({ event: 'telegram_config_missing', message: 'Telegram config missing, skipping notification' });
            return;
        }
        try {
            log.info({ event: 'sending_telegram_message', message: `Sending Telegram message: ${message}` });
            const response = await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: CONFIG.TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
            });
            if (response.status !== 200) {
                throw new Error(`Telegram API returned status ${response.status}`);
            }
            log.success({ event: 'telegram_message_sent', message: 'Telegram message sent successfully' });
        } catch (error: any) {
            log.error({ event: 'telegram_message_failed', message: `Failed to send Telegram message: ${error.message}` });
        }
    }

    private calculateProfitLoss(mint: string, isSell: boolean, amount: number, solAmount: number): { profitSol: number; profitPercent: number } {
        if (!this.tradeRecords[mint]) this.tradeRecords[mint] = [];
        let profitSol = 0;
        let profitPercent = 0;

        if (isSell) {
            const buyTrades = this.tradeRecords[mint].filter(t => t.buyAmount > 0);
            if (buyTrades.length > 0) {
                const avgBuyPrice = buyTrades.reduce((sum, t) => sum + t.buyPriceSol, 0) / buyTrades.length;
                profitSol = solAmount - (amount * avgBuyPrice);
                profitPercent = (profitSol / (amount * avgBuyPrice)) * 100;
                log.info({ event: 'profit_loss_calculated', message: `Calculated profit/loss for ${mint}: ${profitSol.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)` });
            }
        }

        this.tradeRecords[mint].push({
            mint,
            buyPriceSol: isSell ? 0 : solAmount / amount,
            buyAmount: isSell ? 0 : amount,
            sellPriceSol: isSell ? solAmount / amount : 0,
            sellAmount: isSell ? amount : 0,
            timestamp: Date.now(),
        });

        return { profitSol, profitPercent };
    }

    private async getTokenAccount(wallet: PublicKey, mint: PublicKey): Promise<PublicKey | null> {
        try {
            const tokenAccount = await getAssociatedTokenAddress(mint, wallet, false, TOKEN_PROGRAM_ID);
            await getAccount(this.state.httpConnection, tokenAccount);
            return tokenAccount;
        } catch (error) {
            log.error({ event: 'get_token_account_failed', message: `Failed to get token account for mint ${mint.toBase58()}: ${error}` });
            return null;
        }
    }

    private async fetchTokenDecimals(mint: PublicKey): Promise<number> {
        const mintInfo = await this.state.httpConnection.getParsedAccountInfo(mint);
        if (mintInfo.value && 'data' in mintInfo.value) {
            const parsedData = (mintInfo.value.data as { parsed: { info: { decimals: number } } }).parsed;
            if (parsedData?.info?.decimals !== undefined) return parsedData.info.decimals;
        }
        log.warn({ event: 'fetch_decimals_failed', message: `Failed to fetch decimals for mint ${mint.toBase58()}, defaulting to 6` });
        return 6;
    }

    private async getTokenBalance(mint: PublicKey): Promise<{ balance: number; decimals: number; amount: bigint }> {
        try {
            const tokenAccount = await this.getTokenAccount(this.state.owner.publicKey, mint);
            if (!tokenAccount) {
                log.warn({ event: 'no_token_account', message: `No token account found for mint ${mint.toBase58()}` });
                return { balance: 0, decimals: 6, amount: BigInt(0) };
            }
            const balance = await this.state.httpConnection.getTokenAccountBalance(tokenAccount);
            const decimals = await this.fetchTokenDecimals(mint);
            const tokenBalance = {
                balance: parseInt(balance.value.amount, 10) / Math.pow(10, decimals),
                decimals,
                amount: BigInt(balance.value.amount),
            };
            log.info({ event: 'token_balance_fetched', message: `Token balance for mint ${mint.toBase58()}: ${tokenBalance.balance}` });
            return tokenBalance;
        } catch (error) {
            log.error({ event: 'fetch_token_balance_failed', message: `Error fetching token balance for mint ${mint.toBase58()}: ${error}` });
            return { balance: 0, decimals: 6, amount: BigInt(0) };
        }
    }

    private async getQuote(inputMint: PublicKey, outputMint: PublicKey, amount: bigint): Promise<any> {
        try {
            const quoteParams = {
                inputMint: inputMint.toBase58(),
                outputMint: outputMint.toBase58(),
                amount: amount.toString(),
                slippageBps: Math.floor(CONFIG.RAYDIUM_SLIPPAGE * 10000),
                onlyDirectRoutes: false,
            };
            log.info({ event: 'fetching_quote', message: `Fetching quote for ${inputMint.toBase58()} -> ${outputMint.toBase58()} with amount ${amount}` });
            const quoteResponse = await axios.get(`${CONFIG.JUPITER_API}/quote`, { params: quoteParams });
            log.info({ event: 'quote_received', message: `Quote received: ${JSON.stringify(quoteResponse.data)}` });
            return quoteResponse.data;
        } catch (error) {
            log.error({ event: 'fetch_quote_failed', message: `Failed to fetch quote: ${error}` });
            return null;
        }
    }

    private async executeJupiterSwap(quote: any): Promise<{ txId: string | null; receivedSolAmount: number }> {
        try {
            const swapParams = {
                quoteResponse: quote,
                userPublicKey: this.state.owner.publicKey.toBase58(),
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: CONFIG.RAYDIUM_PRIORITY_FEE,
            };
            log.info({ event: 'executing_jupiter_swap', message: `Executing Jupiter swap with params: ${JSON.stringify(swapParams)}` });
            const swapResponse = await axios.post(`${CONFIG.JUPITER_API}/swap`, swapParams);
            if (!swapResponse.data.swapTransaction) {
                log.warn({ event: 'swap_transaction_not_found', message: 'Swap transaction not found in response' });
                return { txId: null, receivedSolAmount: 0 };
            }
            const transaction = VersionedTransaction.deserialize(Buffer.from(swapResponse.data.swapTransaction, 'base64'));
            transaction.sign([this.state.owner]);
            const txId = await this.state.httpConnection.sendRawTransaction(transaction.serialize(), { preflightCommitment: this.commitment, maxRetries: 3 });
            log.info({ event: 'swap_transaction_sent', message: `Swap transaction sent: ${txId}` });
            await this.state.httpConnection.confirmTransaction({ signature: txId, commitment: this.commitment });
            log.success({ event: 'swap_transaction_confirmed', message: `Swap transaction confirmed: ${txId}` });

            let receivedSolAmount = 0;
            const tx = await this.state.httpConnection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0 });
            if (tx && tx.meta) {
                const ownerIndex = tx.transaction.message.accountKeys.findIndex((key: any) => key.pubkey.toBase58() === this.state.owner.publicKey.toBase58());
                if (ownerIndex !== -1) {
                    const preSolBalance = tx.meta.preBalances[ownerIndex] || 0;
                    const postSolBalance = tx.meta.postBalances[ownerIndex] || 0;
                    const fee = tx.meta.fee || 0;
                    receivedSolAmount = (postSolBalance - preSolBalance + fee) / LAMPORTS_PER_SOL;
                    log.info({ event: 'received_sol_amount', message: `Received SOL amount after swap: ${receivedSolAmount}` });
                }
            }

            return { txId, receivedSolAmount };
        } catch (error) {
            log.error({ event: 'jupiter_swap_failed', message: `Failed to execute Jupiter swap: ${error}` });
            return { txId: null, receivedSolAmount: 0 };
        }
    }

    async processTransaction(signature: string, data?: any): Promise<void> {
        if (!signature || typeof signature !== 'string') {
            log.warn({ event: 'invalid_signature', message: 'Invalid signature, skipping' });
            return;
        }
        if (this.processedSignatures.has(signature)) {
            log.info({ event: 'signature_already_processed', message: `Signature ${signature} already processed, skipping` });
            return;
        }

        let tx;
        for (let attempt = 0; attempt < 5; attempt++) {
            tx = await this.state.httpConnection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
            if (tx && tx.meta && tx.blockTime) break;
            log.warn({ event: 'transaction_not_found', message: `Attempt ${attempt + 1}: Transaction ${signature} not found, retrying...` });
            await sleep(2000);
        }

        if (!tx || !tx.meta || !tx.blockTime) {
            log.error({ event: 'transaction_invalid', message: `Transaction ${signature} not found or invalid after retries` });
            return;
        }

        const isRaydiumTx = tx.transaction.message.instructions.some((instr: any) => 'programId' in instr && (instr.programId.equals(RAYDIUM_PROGRAM_ID) || instr.programId.equals(RAYDIUM_CPMM_PROGRAM_ID)));
        const isJupiterTx = tx.transaction.message.instructions.some((instr: any) => 'programId' in instr && instr.programId.equals(JUPITER_PROGRAM_ID));
        const isRaydiumInnerTx = (tx.meta.innerInstructions || []).some((inner: any) =>
            inner.instructions.some((instr: any) => 'programId' in instr && instr.programId.equals(RAYDIUM_CPMM_PROGRAM_ID))
        );
        const hasSwapLog = tx.meta.logMessages?.some((log: string) => log.includes('Swap')) || false;
        const hasRaydiumProgram = tx.meta.logMessages?.some((log: string) => log.includes('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK')) || false;
        let isRaydiumFromData: boolean = false;
        isRaydiumFromData = data?.pool === 'raydium';
        const isRaydium = (isRaydiumTx || isRaydiumInnerTx || hasRaydiumProgram || isRaydiumFromData) && hasSwapLog;

        if (!isRaydium) {
            log.info({ event: 'not_raydium_swap', message: `Transaction ${signature} is not a Raydium swap, skipping` });
            return;
        }
        if (tx.transaction.message.accountKeys[0]?.pubkey.toBase58() !== RAYDIUM_TARGET_WALLET.toBase58()) {
            log.info({ event: 'not_target_wallet', message: `Transaction ${signature} not from target wallet ${RAYDIUM_TARGET_WALLET.toBase58()}, skipping` });
            return;
        }

        this.processedSignatures.add(signature);
        log.info({ event: 'processing_raydium_transaction', message: `Processing Raydium transaction: ${signature}` });

        let inputMint = SOL_MINT;
        let outputMint = SOL_MINT;
        let tokenAmount = 0;
        let solAmount = 0;

        const targetWalletIndex = tx.transaction.message.accountKeys.findIndex((key: any) => key.pubkey.toBase58() === RAYDIUM_TARGET_WALLET.toBase58());
        if (targetWalletIndex === -1) {
            log.error({ event: 'target_wallet_not_found', message: `Target wallet ${RAYDIUM_TARGET_WALLET.toBase58()} not found in transaction ${signature}` });
            return;
        }

        const preSolBalance = tx.meta.preBalances[targetWalletIndex] || 0;
        const postSolBalance = tx.meta.postBalances[targetWalletIndex] || 0;
        const fee = tx.meta.fee || 0;
        const solDecreased = preSolBalance > postSolBalance;

        for (const preBal of tx.meta.preTokenBalances || []) {
            if (preBal.owner !== RAYDIUM_TARGET_WALLET.toBase58()) continue;
            const postBal = (tx.meta.postTokenBalances || []).find((bal: any) => bal.mint === preBal.mint && bal.owner === RAYDIUM_TARGET_WALLET.toBase58());
            const preAmount = parseInt(preBal.uiTokenAmount.amount, 10);
            const postAmount = postBal ? parseInt(postBal.uiTokenAmount.amount, 10) : 0;
            if (preAmount > postAmount) {
                inputMint = new PublicKey(preBal.mint);
                tokenAmount = (preAmount - postAmount) / Math.pow(10, preBal.uiTokenAmount.decimals);
                log.info({ event: 'input_token_detected', message: `Input token: ${inputMint.toBase58()}, amount: ${tokenAmount}` });
                break;
            }
        }

        for (const postBal of tx.meta.postTokenBalances || []) {
            if (postBal.owner !== RAYDIUM_TARGET_WALLET.toBase58()) continue;
            const preBal = (tx.meta.preTokenBalances || []).find((bal: any) => bal.mint === postBal.mint && bal.owner === RAYDIUM_TARGET_WALLET.toBase58());
            const preAmount = preBal ? parseInt(preBal.uiTokenAmount.amount, 10) : 0;
            const postAmount = parseInt(postBal.uiTokenAmount.amount, 10);
            if (postAmount > preAmount) {
                outputMint = new PublicKey(postBal.mint);
                tokenAmount = (postAmount - preAmount) / Math.pow(10, postBal.uiTokenAmount.decimals);
                log.info({ event: 'output_token_detected', message: `Output token: ${outputMint.toBase58()}, amount: ${tokenAmount}` });
                break;
            }
        }

        if (solDecreased && inputMint.equals(SOL_MINT)) {
            solAmount = (preSolBalance - postSolBalance - fee) / LAMPORTS_PER_SOL;
            log.info({ event: 'sol_decreased', message: `SOL decreased, amount: ${solAmount}` });
        }

        if (inputMint.equals(SOL_MINT) && outputMint.equals(SOL_MINT)) {
            log.info({ event: 'no_token_swap', message: `No token swap detected in transaction ${signature}, skipping` });
            return;
        }

        const isBuy = inputMint.equals(SOL_MINT) && !outputMint.equals(SOL_MINT);
        const isSell = !inputMint.equals(SOL_MINT) && outputMint.equals(SOL_MINT);
        const mint = isBuy ? outputMint : inputMint;
        log.info({ event: 'transaction_type_detected', message: `Transaction type: ${isBuy ? 'Buy' : 'Sell'}, mint: ${mint.toBase58()}` });

        this.state.tokenBalances[mint.toBase58()] = this.state.tokenBalances[mint.toBase58()] || { bought: 0, sold: 0 };
        this.state.sourceTokenBalances[mint.toBase58()] = this.state.sourceTokenBalances[mint.toBase58()] || { bought: 0, sold: 0 };
        log.info({ event: 'initial_balances', message: `Initial balances for ${mint.toBase58()}: tokenBalances=${JSON.stringify(this.state.tokenBalances[mint.toBase58()])} sourceTokenBalances=${JSON.stringify(this.state.sourceTokenBalances[mint.toBase58()])}` });

        try {
            const solBalance = await checkSolBalance(this.state.httpConnection, this.state.owner.publicKey);
            const requiredSol = isBuy ? (solAmount * CONFIG.RAYDIUM_TRADE_PERCENTAGE * (1 + CONFIG.RAYDIUM_SLIPPAGE) + 0.00005) : 0.00005;
            log.info({ event: 'sol_balance_check', message: `SOL balance: ${solBalance}, required: ${requiredSol}` });
            if (solBalance < requiredSol) {
                log.warn({ event: 'insufficient_sol_balance', message: `Insufficient SOL balance for transaction ${signature}` });
                return;
            }

            let tradeAmountLamports: bigint | undefined;
            let tradeAmountSolRounded: number | undefined;
            let sellAmountInUnits: bigint | undefined;
            let sellAmount: number | undefined;

            if (isBuy) {
                const tradeAmountSol = solAmount * CONFIG.RAYDIUM_TRADE_PERCENTAGE;
                tradeAmountLamports = BigInt(Math.floor(tradeAmountSol * LAMPORTS_PER_SOL));
                tradeAmountSolRounded = Number(tradeAmountLamports) / LAMPORTS_PER_SOL;
                log.info({ event: 'buy_trade_amount', message: `Buy: tradeAmountSol=${tradeAmountSol}, tradeAmountLamports=${tradeAmountLamports}, tradeAmountSolRounded=${tradeAmountSolRounded}` });

                const minSwapAmount = (CONFIG as any).MIN_SWAP_AMOUNT ?? 0.01;
                if (tradeAmountSolRounded < minSwapAmount) {
                    log.warn({ event: 'trade_amount_below_minimum', message: `Trade amount ${tradeAmountSolRounded} below minimum ${minSwapAmount}, skipping` });
                    return;
                }

                const quote = await this.getQuote(inputMint, outputMint, tradeAmountLamports);
                if (!quote) {
                    log.error({ event: 'quote_failed_buy', message: `Failed to get quote for buy transaction ${signature}` });
                    return;
                }

                this.state.sourceTokenBalances[mint.toBase58()].bought += tokenAmount;
                log.info({ event: 'source_token_balances_updated_buy', message: `Updated sourceTokenBalances after buy: ${JSON.stringify(this.state.sourceTokenBalances[mint.toBase58()])}` });

                const { txId } = await this.executeJupiterSwap(quote);
                if (txId) {
                    await sleep(5000);
                    const { balance: realBalance } = await this.getTokenBalance(outputMint);
                    this.state.tokenBalances[mint.toBase58()].bought = realBalance > 0 ? realBalance : tokenAmount * CONFIG.RAYDIUM_TRADE_PERCENTAGE;
                    log.info({ event: 'token_balances_updated_buy', message: `Updated tokenBalances after buy: ${JSON.stringify(this.state.tokenBalances[mint.toBase58()])}` });
                    await this.sendTelegramMessage(
                        `🟢 <b>Buy (Raydium)</b>\nToken: ${mint.toBase58()}\nAmmount: ${tradeAmountSolRounded.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${txId}`
                    );
                } else {
                    log.error({ event: 'buy_transaction_failed', message: `Buy transaction ${signature} failed, no txId returned` });
                }
            } else if (isSell) {
                this.state.sourceTokenBalances[mint.toBase58()].sold += tokenAmount;
                log.info({ event: 'source_token_balances_updated_sell', message: `Updated sourceTokenBalances after sell: ${JSON.stringify(this.state.sourceTokenBalances[mint.toBase58()])}` });

                const sourceInitialBought = this.state.sourceTokenBalances[mint.toBase58()].bought;
                const targetInitialBought = this.state.tokenBalances[mint.toBase58()].bought;
                const targetSold = this.state.tokenBalances[mint.toBase58()].sold;
                log.info({ event: 'sell_initial_balances', message: `Sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}, targetSold=${targetSold}` });

                if (sourceInitialBought <= 0 || targetInitialBought <= 0) {
                    log.warn({ event: 'invalid_initial_balances_sell', message: `Invalid initial balances for sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}` });
                    return;
                }

                const sellPercentage = tokenAmount / sourceInitialBought;
                const { balance: realBalance, decimals, amount: realAmountInUnits } = await this.getTokenBalance(mint);
                const targetRemaining = Math.max(0, realBalance);
                log.info({ event: 'sell_balance_check', message: `Sell: sellPercentage=${sellPercentage}, realBalance=${realBalance}, targetRemaining=${targetRemaining}` });
                if (targetRemaining <= 0) {
                    log.warn({ event: 'no_tokens_to_sell', message: `No tokens remaining to sell for mint ${mint.toBase58()}` });
                    return;
                }

                sellAmount = targetInitialBought * sellPercentage;
                const totalSellable = targetInitialBought - targetSold;
                if (sellAmount > totalSellable) sellAmount = totalSellable;
                if (sellAmount > targetRemaining) sellAmount = targetRemaining;
                if (sellAmount <= 0) {
                    log.warn({ event: 'invalid_sell_amount', message: `Sell amount ${sellAmount} is invalid, skipping` });
                    return;
                }

                const remainingPercentage = (sourceInitialBought - this.state.sourceTokenBalances[mint.toBase58()].sold) / sourceInitialBought;
                const isLastSale = Math.abs(sellPercentage - remainingPercentage) < 0.01;
                log.info({ event: 'sell_percentage_check', message: `Sell: remainingPercentage=${remainingPercentage}, isLastSale=${isLastSale}` });
                if (isLastSale) {
                    sellAmountInUnits = realAmountInUnits;
                    sellAmount = realBalance;
                } else {
                    sellAmountInUnits = BigInt(Math.ceil(sellAmount * Math.pow(10, decimals)));
                }
                log.info({ event: 'sell_amount_calculated', message: `Sell: sellAmount=${sellAmount}, sellAmountInUnits=${sellAmountInUnits}` });

                const quote = await this.getQuote(inputMint, outputMint, sellAmountInUnits);
                if (!quote) {
                    log.error({ event: 'quote_failed_sell', message: `Failed to get quote for sell transaction ${signature}` });
                    return;
                }

                const { txId, receivedSolAmount } = await this.executeJupiterSwap(quote);
                if (txId) {
                    solAmount = receivedSolAmount > 0 ? receivedSolAmount : solAmount;
                    this.state.tokenBalances[mint.toBase58()].sold += sellAmount;
                    const { balance: updatedBalance } = await this.getTokenBalance(mint);
                    log.info({ event: 'token_balances_updated_sell', message: `Updated tokenBalances after sell: ${JSON.stringify(this.state.tokenBalances[mint.toBase58()])}` });
                    const { profitSol, profitPercent } = this.calculateProfitLoss(mint.toBase58(), true, sellAmount!, solAmount);
                    await this.sendTelegramMessage(
                        `🔴 <b>Sell (Raydium)</b>\nТокен: ${mint.toBase58()}\nAmmount: ${sellAmount.toFixed(4)} токенов\nRecived: ${solAmount.toFixed(4)} SOL\nP/L: ${profitSol >= 0 ? '+' : ''}${profitSol.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)\nTransaction: https://solscan.io/tx/${txId}`
                    );
                } else {
                    log.error({ event: 'sell_transaction_failed', message: `Sell transaction ${signature} failed, no txId returned` });
                }
            }
        } catch (error) {
            log.error({ event: 'transaction_processing_failed', message: `Error processing transaction ${signature}: ${error}` });
        }
    }

    startWebSocket(): void {}
}