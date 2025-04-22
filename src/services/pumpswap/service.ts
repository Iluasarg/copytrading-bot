import {
    Connection,
    Keypair,
    PublicKey,
    ParsedTransactionWithMeta,
    Transaction,
    ComputeBudgetProgram,
    SystemProgram,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    getAssociatedTokenAddressSync,
    createSyncNativeInstruction,
    createCloseAccountInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { PumpSwapSDK, JupiterSDK, TokenBalance, PumpSwapPoolInfo, QuoteResponse } from '.';
import { CONFIG, SOL_MINT, TARGET_WALLET, PUMP_SWAP_PROGRAM_ID } from '../../config';
import { log, sleep, checkTransactionStatus, getTokenBalance, checkSolBalance } from '../../utils';
import chalk from 'chalk';
import axios from 'axios';
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

export class PumpSwapService {
    private processedSignatures: Set<string>;
    private connection: Connection;
    private pumpSwapSDK: PumpSwapSDK;
    private jupiterSDK: JupiterSDK;
    private owner: Keypair;
    private tokenBalances: Record<string, TokenBalance>;
    private sourceTokenBalances: Record<string, TokenBalance>;
    private tradeRecords: Record<string, TradeRecord[]>;

    constructor(processedSignatures: Set<string>) {
        this.processedSignatures = processedSignatures;
        this.owner = Keypair.fromSecretKey(bs58.decode(CONFIG.WALLET_PRIVATE_KEY));
        this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
        this.pumpSwapSDK = new PumpSwapSDK(this.connection, this.owner);
        this.jupiterSDK = new JupiterSDK(this.connection, this.owner);
        this.tokenBalances = {};
        this.sourceTokenBalances = {};
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

    private async sendTelegramNotification(message: string): Promise<void> {
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

        this.tradeRecords[mint].push({
            mint,
            buyPriceSol: isSell ? 0 : solAmount / amount,
            buyAmount: isSell ? 0 : amount,
            sellPriceSol: isSell ? solAmount / amount : 0,
            sellAmount: isSell ? amount : 0,
            timestamp: Date.now(),
        });

        if (isSell) {
            const buyTrades = this.tradeRecords[mint].filter(t => t.buyAmount > 0);
            const totalBuyAmount = buyTrades.reduce((sum, t) => sum + t.buyAmount, 0);
            const totalBuyCostSol = buyTrades.reduce((sum, t) => sum + (t.buyPriceSol * t.buyAmount), 0);

            const sellTrades = this.tradeRecords[mint].filter(t => t.sellAmount > 0);
            const totalSellAmount = sellTrades.reduce((sum, t) => sum + t.sellAmount, 0);
            const totalSellRevenueSol = sellTrades.reduce((sum, t) => sum + (t.sellPriceSol * t.sellAmount), 0);

            if (totalBuyAmount > 0 && totalSellAmount > 0) {
                const avgBuyPrice = totalBuyCostSol / totalBuyAmount;
                profitSol = totalSellRevenueSol - (avgBuyPrice * totalSellAmount);
                profitPercent = totalBuyCostSol > 0 ? (profitSol / totalBuyCostSol) * 100 : 0;
                log.info({ event: 'profit_loss_calculated', message: `Calculated profit/loss for ${mint}: ${profitSol.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)` });
            } else {
                log.warn({ event: 'insufficient_data_for_profit', message: `Insufficient data for profit/loss calculation for ${mint}` });
            }
        }

        return { profitSol, profitPercent };
    }

    async ensureAssociatedTokenAccount(mint: PublicKey): Promise<void> {
        const ata = getAssociatedTokenAddressSync(mint, this.owner.publicKey);
        const tokenAccounts = await this.connection.getTokenAccountsByOwner(this.owner.publicKey, { programId: TOKEN_PROGRAM_ID, mint });
        if (tokenAccounts.value.length === 0) {
            const transaction = new Transaction();
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = this.owner.publicKey;
            transaction.add(
                ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE }),
                createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, ata, this.owner.publicKey, mint)
            );
            const signature = await this.connection.sendTransaction(transaction, [this.owner], { skipPreflight: false, maxRetries: 5 });
            let isConfirmed = false;
            for (let attempt = 0; attempt < 5; attempt++) {
                isConfirmed = await checkTransactionStatus(this.connection, signature);
                if (isConfirmed) break;
                await sleep(2000);
            }
            if (!isConfirmed) {
                log.error({ event: 'create_ata_failed', message: `Failed to create ATA: ${signature}` });
                throw new Error(`Failed to create ATA: ${signature}`);
            }
            log.info({ event: 'ata_created', message: `Associated token account created: ${ata.toBase58()}` });
        }
    }

    async ensureWrappedSolAccount(amount: number = 0): Promise<void> {
        const wrappedSolAta = getAssociatedTokenAddressSync(SOL_MINT, this.owner.publicKey);
        const tokenAccounts = await this.connection.getTokenAccountsByOwner(this.owner.publicKey, { programId: TOKEN_PROGRAM_ID, mint: SOL_MINT });

        if (tokenAccounts.value.length > 0) {
            if (amount > 0) {
                const wsolBalance = await getTokenBalance(this.connection, this.owner.publicKey, SOL_MINT);
                const adjustedAmount = amount * (1 + CONFIG.SLIPPAGE);
                if (wsolBalance.balance >= adjustedAmount) {
                    log.info({ event: 'wsol_balance_sufficient', message: `WSOL balance sufficient: ${wsolBalance.balance} >= ${adjustedAmount}` });
                    return;
                }
            } else {
                log.info({ event: 'wsol_account_exists', message: 'WSOL account already exists, no amount to wrap' });
                return;
            }
        }

        const transaction = new Transaction();
        const { blockhash } = await this.connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = this.owner.publicKey;

        if (tokenAccounts.value.length === 0) {
            transaction.add(
                createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, wrappedSolAta, this.owner.publicKey, SOL_MINT)
            );
        }

        if (amount > 0) {
            const adjustedAmount = amount * (1 + CONFIG.SLIPPAGE);
            const lamports = Math.floor(adjustedAmount * LAMPORTS_PER_SOL);
            const rentExemptLamports = 2039280;
            const totalLamports = lamports + (tokenAccounts.value.length === 0 ? rentExemptLamports : 0);

            const solBalance = await checkSolBalance(this.connection, this.owner.publicKey);
            if (solBalance * LAMPORTS_PER_SOL < totalLamports + 5000) {
                log.error({ event: 'insufficient_sol_for_wsol', message: `Insufficient SOL: required ${(totalLamports + 5000) / LAMPORTS_PER_SOL} SOL, available ${solBalance} SOL` });
                throw new Error(`Insufficient SOL: required ${(totalLamports + 5000) / LAMPORTS_PER_SOL} SOL, available ${solBalance} SOL`);
            }

            transaction.add(
                SystemProgram.transfer({ fromPubkey: this.owner.publicKey, toPubkey: wrappedSolAta, lamports: totalLamports }),
                createSyncNativeInstruction(wrappedSolAta)
            );
        }

        transaction.add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE })
        );

        const signature = await this.connection.sendTransaction(transaction, [this.owner], { skipPreflight: false, maxRetries: 5 });
        let isConfirmed = false;
        for (let attempt = 0; attempt < 5; attempt++) {
            isConfirmed = await checkTransactionStatus(this.connection, signature);
            if (isConfirmed) break;
            await sleep(2000);
        }
        if (!isConfirmed) {
            log.error({ event: 'init_wsol_failed', message: `Failed to initialize WSOL: ${signature}` });
            throw new Error(`Failed to initialize WSOL: ${signature}`);
        }
        log.info({ event: 'wsol_initialized', message: `WSOL account initialized with ${amount} SOL` });
    }

    async processTransaction(signature: string, data: any): Promise<void> {
        if (!signature || typeof signature !== 'string') {
            log.warn({ event: 'invalid_signature', message: 'Invalid signature, skipping' });
            return;
        }
        if (this.processedSignatures.has(signature)) {
            log.info({ event: 'signature_already_processed', message: `Signature ${signature} already processed, skipping` });
            return;
        }

        let tx: ParsedTransactionWithMeta | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            tx = await this.connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (tx && tx.meta && tx.blockTime) break;
            log.warn({ event: 'transaction_not_found', message: `Attempt ${attempt + 1}: Transaction ${signature} not found, retrying...` });
            await sleep(2000);
        }
        if (!tx || !tx.meta || !tx.blockTime) {
            log.error({ event: 'transaction_invalid', message: `Transaction ${signature} not found or invalid after retries` });
            return;
        }

        const targetWalletAddress: string = TARGET_WALLET.toBase58();
        const transactionWalletAddress: string = tx.transaction.message.accountKeys[0]?.pubkey
            ? tx.transaction.message.accountKeys[0].pubkey.toBase58()
            : '';
        if (transactionWalletAddress !== targetWalletAddress) {
            log.info({ event: 'not_target_wallet', message: `Transaction ${signature} not from target wallet ${targetWalletAddress}, skipping` });
            return;
        }

        const isPumpSwapProgram = tx.transaction.message.accountKeys.some(key => key.pubkey.toBase58() === PUMP_SWAP_PROGRAM_ID.toBase58());
        const hasPumpSwapLog = tx.meta.logMessages?.some(log =>
            log.includes('Instruction: Buy') ||
            log.includes('Instruction: Sell') ||
            log.includes('pump-amm')
        ) || false;
        const isPumpSwapFromData = data?.pool === 'pump-amm';
        const isPumpSwap = isPumpSwapProgram || hasPumpSwapLog || isPumpSwapFromData;
        if (!isPumpSwap) {
            log.info({ event: 'not_pump_swap', message: `Transaction ${signature} is not a PumpSwap transaction, skipping` });
            return;
        }

        this.processedSignatures.add(signature);
        log.info({ event: 'processing_pump_swap_transaction', message: `Processing PumpSwap transaction: ${signature}` });

        let inputMint = SOL_MINT;
        let outputMint = SOL_MINT;
        let tokenAmount = 0;
        let solAmount = 0;

        const targetWalletIndex = tx.transaction.message.accountKeys.findIndex(key => key.pubkey.toBase58() === targetWalletAddress);
        if (targetWalletIndex === -1) {
            log.error({ event: 'target_wallet_not_found', message: `Target wallet ${targetWalletAddress} not found in transaction ${signature}` });
            return;
        }

        const preSolBalance = tx.meta.preBalances[targetWalletIndex] || 0;
        const postSolBalance = tx.meta.postBalances[targetWalletIndex] || 0;
        const fee = tx.meta.fee || 0;
        const solDecreased = preSolBalance > postSolBalance;

        for (const preBal of tx.meta.preTokenBalances || []) {
            if (preBal.owner !== targetWalletAddress) continue;
            const postBal = (tx.meta.postTokenBalances || []).find(bal => bal.mint === preBal.mint && bal.owner === targetWalletAddress);
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
            if (postBal.owner !== targetWalletAddress) continue;
            const preBal = (tx.meta.preTokenBalances || []).find(bal => bal.mint === postBal.mint && bal.owner === targetWalletAddress);
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

        if (!this.tokenBalances[mint.toBase58()]) this.tokenBalances[mint.toBase58()] = { bought: 0, sold: 0 };
        if (!this.sourceTokenBalances[mint.toBase58()]) this.sourceTokenBalances[mint.toBase58()] = { bought: 0, sold: 0 };
        log.info({ event: 'initial_balances', message: `Initial balances for ${mint.toBase58()}: tokenBalances=${JSON.stringify(this.tokenBalances[mint.toBase58()])} sourceTokenBalances=${JSON.stringify(this.sourceTokenBalances[mint.toBase58()])}` });

        try {
            const solBalance = await checkSolBalance(this.connection, this.owner.publicKey);
            const requiredSol = isBuy ? (solAmount * CONFIG.TRADE_PERCENTAGE * (1 + CONFIG.SLIPPAGE) + 0.00005) : 0.00005;
            log.info({ event: 'sol_balance_check', message: `SOL balance: ${solBalance}, required: ${requiredSol}` });
            if (solBalance < requiredSol) {
                log.warn({ event: 'insufficient_sol_balance', message: `Insufficient SOL balance for transaction ${signature}` });
                return;
            }

            let poolResult: { poolInfo: PumpSwapPoolInfo | null; quote: QuoteResponse | null };
            let tradeAmountLamports: bigint | undefined;
            let tradeAmountSolRounded: number | undefined;
            let sellAmountInUnits: bigint | undefined;
            let sellAmount: number | undefined;

            if (isBuy) {
                const tradeAmountSol = solAmount * CONFIG.TRADE_PERCENTAGE;
                tradeAmountLamports = BigInt(Math.floor(tradeAmountSol * LAMPORTS_PER_SOL));
                tradeAmountSolRounded = Number(tradeAmountLamports) / LAMPORTS_PER_SOL;
                log.info({ event: 'buy_trade_amount', message: `Buy: tradeAmountSol=${tradeAmountSol}, tradeAmountLamports=${tradeAmountLamports}, tradeAmountSolRounded=${tradeAmountSolRounded}` });
                poolResult = await this.jupiterSDK.getPumpSwapPool(SOL_MINT, mint, tradeAmountLamports, CONFIG.SLIPPAGE);
                if (!poolResult || !poolResult.quote) {
                    log.error({ event: 'pool_or_quote_missing_buy', message: `Failed to get pool or quote for buy transaction ${signature}` });
                    return;
                }
            } else {
                const { amount: tokenAmountInUnits } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
                poolResult = await this.jupiterSDK.getPumpSwapPool(mint, SOL_MINT, tokenAmountInUnits, CONFIG.SLIPPAGE);
                if (!poolResult || !poolResult.quote) {
                    log.error({ event: 'pool_or_quote_missing_sell', message: `Failed to get pool or quote for sell transaction ${signature}` });
                    return;
                }
            }

            const { poolInfo, quote } = poolResult;

            if (isBuy && tradeAmountSolRounded === undefined) {
                log.warn({ event: 'trade_amount_undefined', message: `Trade amount undefined for buy transaction ${signature}, skipping` });
                return;
            }

            if (isBuy) {
                const minTradeAmount = (CONFIG as any).MIN_TRADE_AMOUNT ?? 0.01;
                if (tradeAmountSolRounded! < minTradeAmount) {
                    log.warn({ event: 'trade_amount_below_minimum', message: `Trade amount ${tradeAmountSolRounded} below minimum ${minTradeAmount}, skipping` });
                    return;
                }
            }

            if (poolInfo) {
                const isValidPool = await this.pumpSwapSDK.validatePool(poolInfo.poolAddress);
                if (isValidPool) {
                    if (isBuy) {
                        this.sourceTokenBalances[mint.toBase58()].bought += tokenAmount;
                        log.info({ event: 'source_token_balances_updated_buy', message: `Updated sourceTokenBalances after buy: ${JSON.stringify(this.sourceTokenBalances[mint.toBase58()])}` });
                        await this.ensureAssociatedTokenAccount(mint);
                        await this.ensureWrappedSolAccount(tradeAmountSolRounded!);

                        try {
                            const uuid = await this.pumpSwapSDK.buy(poolInfo.poolAddress, tradeAmountLamports!, mint, this.owner, CONFIG.SLIPPAGE);
                            await sleep(5000);
                            const { balance: realBalance } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
                            this.tokenBalances[mint.toBase58()].bought = realBalance > 0 ? realBalance : tokenAmount * CONFIG.TRADE_PERCENTAGE;
                            log.info({ event: 'token_balances_updated_buy', message: `Updated tokenBalances after buy: ${JSON.stringify(this.tokenBalances[mint.toBase58()])}` });
                            await this.sendTelegramNotification(
                                `🟢 <b>Buy (PumpSwap)</b>\nToken: ${mint.toBase58()}\nAmmount: ${tradeAmountSolRounded!.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${uuid}`
                            );
                        } catch (error: any) {
                            log.error({ event: 'buy_failed', message: `Failed to execute buy transaction ${signature}: ${error.message}` });
                            return;
                        }
                    } else if (isSell) {
                        this.sourceTokenBalances[mint.toBase58()].sold += tokenAmount;
                        log.info({ event: 'source_token_balances_updated_sell', message: `Updated sourceTokenBalances after sell: ${JSON.stringify(this.sourceTokenBalances[mint.toBase58()])}` });

                        const sourceInitialBought = this.sourceTokenBalances[mint.toBase58()].bought;
                        const targetInitialBought = this.tokenBalances[mint.toBase58()].bought;
                        const targetSold = this.tokenBalances[mint.toBase58()].sold;
                        log.info({ event: 'sell_initial_balances', message: `Sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}, targetSold=${targetSold}` });

                        if (sourceInitialBought <= 0 || targetInitialBought <= 0) {
                            log.warn({ event: 'invalid_initial_balances_sell', message: `Invalid initial balances for sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}` });
                            return;
                        }

                        const sellPercentage = tokenAmount / sourceInitialBought;
                        const { balance: realBalance, decimals, amount: realAmountInUnits } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
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

                        const remainingPercentage = (sourceInitialBought - this.sourceTokenBalances[mint.toBase58()].sold) / sourceInitialBought;
                        const isLastSale = Math.abs(sellPercentage - remainingPercentage) < 0.01;
                        log.info({ event: 'sell_percentage_check', message: `Sell: remainingPercentage=${remainingPercentage}, isLastSale=${isLastSale}` });
                        if (isLastSale) {
                            sellAmountInUnits = realAmountInUnits;
                            sellAmount = realBalance;
                        } else {
                            sellAmountInUnits = BigInt(Math.ceil(sellAmount * Math.pow(10, decimals)));
                        }
                        log.info({ event: 'sell_amount_calculated', message: `Sell: sellAmount=${sellAmount}, sellAmountInUnits=${sellAmountInUnits}` });

                        await this.ensureWrappedSolAccount(0);

                        try {
                            const sellInstruction = await this.pumpSwapSDK.createSellInstruction(
                                poolInfo.poolAddress,
                                mint,
                                sellAmountInUnits!,
                                this.owner,
                                CONFIG.SLIPPAGE
                            );

                            const transaction = new Transaction();
                            const { blockhash } = await this.connection.getLatestBlockhash();
                            transaction.recentBlockhash = blockhash;
                            transaction.feePayer = this.owner.publicKey;
                            transaction.add(
                                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CONFIG.PRIORITY_FEE }),
                                createAssociatedTokenAccountIdempotentInstruction(this.owner.publicKey, getAssociatedTokenAddressSync(mint, this.owner.publicKey), this.owner.publicKey, mint),
                                sellInstruction
                            );

                            const willSellAllTokens = sellAmount! >= targetRemaining || isLastSale;
                            if (willSellAllTokens) {
                                const wrappedSolAta = getAssociatedTokenAddressSync(SOL_MINT, this.owner.publicKey);
                                transaction.add(createCloseAccountInstruction(wrappedSolAta, this.owner.publicKey, this.owner.publicKey));
                            }

                            const signatureSell = await this.connection.sendTransaction(transaction, [this.owner], { skipPreflight: false, maxRetries: 5 });
                            let isConfirmed = false;
                            for (let attempt = 0; attempt < 5; attempt++) {
                                isConfirmed = await checkTransactionStatus(this.connection, signatureSell);
                                if (isConfirmed) break;
                                await sleep(2000);
                            }
                            if (!isConfirmed) {
                                log.error({ event: 'sell_transaction_not_confirmed', message: `Sell transaction ${signatureSell} not confirmed` });
                                return;
                            }

                            let receivedSolAmount = 0;
                            const sellTx = await this.connection.getParsedTransaction(signatureSell, { maxSupportedTransactionVersion: 0 });
                            if (sellTx && sellTx.meta) {
                                const ownerIndex = sellTx.transaction.message.accountKeys.findIndex((key: any) => key.pubkey.toBase58() === this.owner.publicKey.toBase58());
                                if (ownerIndex !== -1) {
                                    const preBal = sellTx.meta.preBalances[ownerIndex] || 0;
                                    const postBal = sellTx.meta.postBalances[ownerIndex] || 0;
                                    const txFee = sellTx.meta.fee || 0;
                                    receivedSolAmount = (postBal - preBal + txFee) / LAMPORTS_PER_SOL;
                                    log.info({ event: 'received_sol_amount_sell', message: `Received SOL amount after sell: ${receivedSolAmount}` });
                                }
                            }

                            this.tokenBalances[mint.toBase58()].sold += sellAmount!;
                            const { balance: updatedBalance } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
                            log.info({ event: 'token_balances_updated_sell', message: `Updated tokenBalances after sell: ${JSON.stringify(this.tokenBalances[mint.toBase58()])}` });
                            const { profitSol, profitPercent } = this.calculateProfitLoss(mint.toBase58(), true, sellAmount!, receivedSolAmount);
                            await this.sendTelegramNotification(
                                `🔴 <b>Sell (PumpSwap)</b>\nToken: ${mint.toBase58()}\nAmmount: ${sellAmount.toFixed(4)} токенов\nRecived: ${receivedSolAmount.toFixed(4)} SOL\nP/L: ${profitSol >= 0 ? '+' : ''}${profitSol.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)\nTransaction: https://solscan.io/tx/${signatureSell}`
                            );
                        } catch (error: any) {
                            log.error({ event: 'sell_failed', message: `Failed to execute sell transaction ${signature}: ${error.message}` });
                            return;
                        }
                    }
                } else {
                    if (quote) {
                        if (isBuy) {
                            this.sourceTokenBalances[mint.toBase58()].bought += tokenAmount;
                            log.info({ event: 'source_token_balances_updated_buy', message: `Updated sourceTokenBalances after buy: ${JSON.stringify(this.sourceTokenBalances[mint.toBase58()])}` });
                            const txId = await this.jupiterSDK.executeSwap(quote);
                            if (txId) {
                                await sleep(5000);
                                const { balance: realBalance } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
                                this.tokenBalances[mint.toBase58()].bought = realBalance > 0 ? realBalance : tokenAmount * CONFIG.TRADE_PERCENTAGE;
                                log.info({ event: 'token_balances_updated_buy', message: `Updated tokenBalances after buy: ${JSON.stringify(this.tokenBalances[mint.toBase58()])}` });
                                await this.sendTelegramNotification(
                                    `🟢 <b>Buy (PumpSwap, Jupiter)</b>\nТокен: ${mint.toBase58()}\nAmmount: ${tradeAmountSolRounded!.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${txId}`
                                );
                            } else {
                                log.error({ event: 'jupiter_buy_failed', message: `Failed to execute Jupiter buy transaction ${signature}, no txId returned` });
                            }
                        } else if (isSell) {
                            this.sourceTokenBalances[mint.toBase58()].sold += tokenAmount;
                            log.info({ event: 'source_token_balances_updated_sell', message: `Updated sourceTokenBalances after sell: ${JSON.stringify(this.sourceTokenBalances[mint.toBase58()])}` });

                            const sourceInitialBought = this.sourceTokenBalances[mint.toBase58()].bought;
                            const targetInitialBought = this.tokenBalances[mint.toBase58()].bought;
                            const targetSold = this.tokenBalances[mint.toBase58()].sold;
                            log.info({ event: 'sell_initial_balances', message: `Sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}, targetSold=${targetSold}` });

                            if (sourceInitialBought <= 0 || targetInitialBought <= 0) {
                                log.warn({ event: 'invalid_initial_balances_sell', message: `Invalid initial balances for sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}` });
                                return;
                            }

                            const sellPercentage = tokenAmount / sourceInitialBought;
                            const { balance: realBalance, decimals } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
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

                            const remainingPercentage = (sourceInitialBought - this.sourceTokenBalances[mint.toBase58()].sold) / sourceInitialBought;
                            const isLastSale = Math.abs(sellPercentage - remainingPercentage) < 0.01;
                            log.info({ event: 'sell_percentage_check', message: `Sell: remainingPercentage=${remainingPercentage}, isLastSale=${isLastSale}` });
                            if (isLastSale) {
                                sellAmountInUnits = (await getTokenBalance(this.connection, this.owner.publicKey, mint)).amount;
                                sellAmount = realBalance;
                            } else {
                                sellAmountInUnits = BigInt(Math.ceil(sellAmount * Math.pow(10, decimals)));
                            }
                            log.info({ event: 'sell_amount_calculated', message: `Sell: sellAmount=${sellAmount}, sellAmountInUnits=${sellAmountInUnits}` });

                            const txId = await this.jupiterSDK.executeSwap(quote);
                            if (txId) {
                                let isConfirmed = false;
                                for (let attempt = 0; attempt < 5; attempt++) {
                                    isConfirmed = await checkTransactionStatus(this.connection, txId);
                                    if (isConfirmed) break;
                                    await sleep(2000);
                                }
                                if (!isConfirmed) {
                                    log.error({ event: 'jupiter_sell_not_confirmed', message: `Jupiter sell transaction ${txId} not confirmed` });
                                    return;
                                }

                                let receivedSolAmount = 0;
                                const sellTx = await this.connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0 });
                                if (sellTx && sellTx.meta) {
                                    const ownerIndex = sellTx.transaction.message.accountKeys.findIndex((key: any) => key.pubkey.toBase58() === this.owner.publicKey.toBase58());
                                    if (ownerIndex !== -1) {
                                        const preBal = sellTx.meta.preBalances[ownerIndex] || 0;
                                        const postBal = sellTx.meta.postBalances[ownerIndex] || 0;
                                        const txFee = sellTx.meta.fee || 0;
                                        receivedSolAmount = (postBal - preBal + txFee) / LAMPORTS_PER_SOL;
                                        log.info({ event: 'received_sol_amount_sell', message: `Received SOL amount after sell: ${receivedSolAmount}` });
                                    }
                                }

                                this.tokenBalances[mint.toBase58()].sold += sellAmount!;
                                const { balance: updatedBalance } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
                                log.info({ event: 'token_balances_updated_sell', message: `Updated tokenBalances after sell: ${JSON.stringify(this.tokenBalances[mint.toBase58()])}` });
                                const { profitSol, profitPercent } = this.calculateProfitLoss(mint.toBase58(), true, sellAmount!, receivedSolAmount);
                                await this.sendTelegramNotification(
                                    `🔴 <b>Sell (PumpSwap, Jupiter)</b>\nToken: ${mint.toBase58()}\nAmmount: ${sellAmount.toFixed(4)} token\nRecived: ${receivedSolAmount.toFixed(4)} SOL\nP/L: ${profitSol >= 0 ? '+' : ''}${profitSol.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)\nTransaction: https://solscan.io/tx/${txId}`
                                );
                            } else {
                                log.error({ event: 'jupiter_sell_failed', message: `Failed to execute Jupiter sell transaction ${signature}, no txId returned` });
                            }
                        }
                    } else {
                        log.warn({ event: 'invalid_pool_no_quote', message: `Invalid pool and no quote for transaction ${signature}, skipping` });
                        return;
                    }
                }
            } else if (quote) {
                if (isBuy) {
                    this.sourceTokenBalances[mint.toBase58()].bought += tokenAmount;
                    log.info({ event: 'source_token_balances_updated_buy', message: `Updated sourceTokenBalances after buy: ${JSON.stringify(this.sourceTokenBalances[mint.toBase58()])}` });
                    const txId = await this.jupiterSDK.executeSwap(quote);
                    if (txId) {
                        await sleep(5000);
                        const { balance: realBalance } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
                        this.tokenBalances[mint.toBase58()].bought = realBalance > 0 ? realBalance : tokenAmount * CONFIG.TRADE_PERCENTAGE;
                        log.info({ event: 'token_balances_updated_buy', message: `Updated tokenBalances after buy: ${JSON.stringify(this.tokenBalances[mint.toBase58()])}` });
                        await this.sendTelegramNotification(
                            `🟢 <b>Buy (PumpSwap, Jupiter)</b>\nToken: ${mint.toBase58()}\nAmmount: ${tradeAmountSolRounded!.toFixed(4)} SOL\nTransaction: https://solscan.io/tx/${txId}`
                        );
                    } else {
                        log.error({ event: 'jupiter_buy_failed', message: `Failed to execute Jupiter buy transaction ${signature}, no txId returned` });
                    }
                } else if (isSell) {
                    this.sourceTokenBalances[mint.toBase58()].sold += tokenAmount;
                    log.info({ event: 'source_token_balances_updated_sell', message: `Updated sourceTokenBalances after sell: ${JSON.stringify(this.sourceTokenBalances[mint.toBase58()])}` });

                    const sourceInitialBought = this.sourceTokenBalances[mint.toBase58()].bought;
                    const targetInitialBought = this.tokenBalances[mint.toBase58()].bought;
                    const targetSold = this.tokenBalances[mint.toBase58()].sold;
                    log.info({ event: 'sell_initial_balances', message: `Sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}, targetSold=${targetSold}` });

                    if (sourceInitialBought <= 0 || targetInitialBought <= 0) {
                        log.warn({ event: 'invalid_initial_balances_sell', message: `Invalid initial balances for sell: sourceInitialBought=${sourceInitialBought}, targetInitialBought=${targetInitialBought}` });
                        return;
                    }

                    const sellPercentage = tokenAmount / sourceInitialBought;
                    const { balance: realBalance, decimals } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
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

                    const remainingPercentage = (sourceInitialBought - this.sourceTokenBalances[mint.toBase58()].sold) / sourceInitialBought;
                    const isLastSale = Math.abs(sellPercentage - remainingPercentage) < 0.01;
                    log.info({ event: 'sell_percentage_check', message: `Sell: remainingPercentage=${remainingPercentage}, isLastSale=${isLastSale}` });
                    if (isLastSale) {
                        sellAmountInUnits = (await getTokenBalance(this.connection, this.owner.publicKey, mint)).amount;
                        sellAmount = realBalance;
                    } else {
                        sellAmountInUnits = BigInt(Math.ceil(sellAmount * Math.pow(10, decimals)));
                    }
                    log.info({ event: 'sell_amount_calculated', message: `Sell: sellAmount=${sellAmount}, sellAmountInUnits=${sellAmountInUnits}` });

                    const txId = await this.jupiterSDK.executeSwap(quote);
                    if (txId) {
                        let isConfirmed = false;
                        for (let attempt = 0; attempt < 5; attempt++) {
                            isConfirmed = await checkTransactionStatus(this.connection, txId);
                            if (isConfirmed) break;
                            await sleep(2000);
                        }
                        if (!isConfirmed) {
                            log.error({ event: 'jupiter_sell_not_confirmed', message: `Jupiter sell transaction ${txId} not confirmed` });
                            return;
                        }

                        let receivedSolAmount = 0;
                        const sellTx = await this.connection.getParsedTransaction(txId, { maxSupportedTransactionVersion: 0 });
                        if (sellTx && sellTx.meta) {
                            const ownerIndex = sellTx.transaction.message.accountKeys.findIndex((key: any) => key.pubkey.toBase58() === this.owner.publicKey.toBase58());
                            if (ownerIndex !== -1) {
                                const preBal = sellTx.meta.preBalances[ownerIndex] || 0;
                                const postBal = sellTx.meta.postBalances[ownerIndex] || 0;
                                const txFee = sellTx.meta.fee || 0;
                                receivedSolAmount = (postBal - preBal + txFee) / LAMPORTS_PER_SOL;
                                log.info({ event: 'received_sol_amount_sell', message: `Received SOL amount after sell: ${receivedSolAmount}` });
                            }
                        }

                        this.tokenBalances[mint.toBase58()].sold += sellAmount!;
                        const { balance: updatedBalance } = await getTokenBalance(this.connection, this.owner.publicKey, mint);
                        log.info({ event: 'token_balances_updated_sell', message: `Updated tokenBalances after sell: ${JSON.stringify(this.tokenBalances[mint.toBase58()])}` });
                        const { profitSol, profitPercent } = this.calculateProfitLoss(mint.toBase58(), true, sellAmount!, receivedSolAmount);
                        await this.sendTelegramNotification(
                            `🔴 <b>Sell (PumpSwap, Jupiter)</b>\nToken: ${mint.toBase58()}\nAmmount: ${sellAmount.toFixed(4)} токенов\nRecived: ${receivedSolAmount.toFixed(4)} SOL\nP/L: ${profitSol >= 0 ? '+' : ''}${profitSol.toFixed(4)} SOL (${profitPercent.toFixed(2)}%)\nTransaction: https://solscan.io/tx/${txId}`
                        );
                    } else {
                        log.error({ event: 'jupiter_sell_failed', message: `Failed to execute Jupiter sell transaction ${signature}, no txId returned` });
                    }
                }
            } else {
                log.warn({ event: 'no_pool_or_quote', message: `No pool or quote for transaction ${signature}, skipping` });
                return;
            }
        } catch (error: any) {
            log.error({ event: 'transaction_processing_failed', message: `Error processing transaction ${signature}: ${error.message}` });
        }
    }

    startWebSocket(): void {}
}