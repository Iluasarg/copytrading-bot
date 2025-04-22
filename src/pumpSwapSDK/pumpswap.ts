import { Connection, Keypair, PublicKey, TransactionInstruction, VersionedTransaction, ComputeBudgetProgram, TransactionMessage, Transaction } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet, Provider, BN } from "@coral-xyz/anchor";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { sendBundle } from "./jito/bundle";
import { IDL } from "./IDL/index";

interface PoolData {
    poolBaseTokenAccount: PublicKey;
    poolQuoteTokenAccount: PublicKey;
    [key: string]: any;
}

export class PumpSwapSDK {
    connection: Connection;
    program: Program;
    programId: PublicKey;

    constructor(connection: Connection, wallet: Keypair) {
        this.connection = connection;
        this.programId = new PublicKey('6EF8rrecthR5DkS9UqRuntc2rH2ZrT1rW1ZxN2aNh6L'); // Исправлен programId

        const anchorWallet: Wallet = {
            publicKey: wallet.publicKey,
            payer: wallet,
            signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T): Promise<T> => {
                if (!(tx instanceof VersionedTransaction)) throw new Error("Only VersionedTransaction is supported");
                tx.sign([wallet]);
                return tx as T;
            },
            signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> => {
                for (const tx of txs) {
                    if (!(tx instanceof VersionedTransaction)) throw new Error("Only VersionedTransaction is supported");
                    (tx as VersionedTransaction).sign([wallet]);
                }
                return txs;
            },
        };

        const provider: Provider = new AnchorProvider(connection, anchorWallet, { commitment: "confirmed" });
        this.program = new Program(IDL, this.programId, provider);
    }

    async validatePool(poolAddress: PublicKey): Promise<boolean> {
        try {
            const poolAccount = await this.connection.getAccountInfo(poolAddress);
            if (!poolAccount) {
                console.error(`Пул ${poolAddress.toBase58()} не существует`);
                return false;
            }

            const poolData: PoolData = this.program.coder.accounts.decode("Pool", poolAccount.data);
            if (!poolData.poolBaseTokenAccount || !poolData.poolQuoteTokenAccount) {
                console.error(`Отсутствуют обязательные поля в poolData: poolBaseTokenAccount=${poolData.poolBaseTokenAccount}, poolQuoteTokenAccount=${poolData.poolQuoteTokenAccount}`);
                return false;
            }

            const baseAccountInfo = await this.connection.getAccountInfo(poolData.poolBaseTokenAccount);
            const quoteAccountInfo = await this.connection.getAccountInfo(poolData.poolQuoteTokenAccount);

            if (!baseAccountInfo || !quoteAccountInfo) {
                console.error(`Токен-аккаунты пула ${poolAddress.toBase58()} не существуют`);
                return false;
            }

            if (!baseAccountInfo.owner.equals(TOKEN_PROGRAM_ID) || !quoteAccountInfo.owner.equals(TOKEN_PROGRAM_ID)) {
                console.error(`baseTokenAccount или quoteTokenAccount в пуле ${poolAddress.toBase58()} не являются токен-аккаунтами`);
                return false;
            }

            return true;
        } catch (error) {
            console.error(`Ошибка валидации пула ${poolAddress.toBase58()}: ${error}`);
            return false;
        }
    }

    async buy(pool: PublicKey, amountSol: bigint, tokenMint: PublicKey, wallet: Keypair, slippage: number = 0.25) {
        const isValidPool = await this.validatePool(pool);
        if (!isValidPool) {
            throw new Error(`Пул ${pool.toBase58()} невалиден`);
        }

        const instruction = await this.createBuyInstruction(pool, tokenMint, amountSol, wallet, slippage);
        const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');

        const ata = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);
        const instructions = [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
            createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, tokenMint),
            instruction,
        ];

        const message = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions,
        }).compileToV0Message();
        const messageV0 = new VersionedTransaction(message);
        messageV0.sign([wallet]);

        const uuid = await sendBundle(false, latestBlockhash.blockhash, messageV0, pool, wallet);
        return uuid;
    }

    async createBuyInstruction(poolAddress: PublicKey, tokenMint: PublicKey, amountSol: bigint, wallet: Keypair, slippage: number = 0.25): Promise<TransactionInstruction> {
        const quoteMint = new PublicKey('So11111111111111111111111111111111111111112');
        const userBaseAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

        const poolAccount = await this.connection.getAccountInfo(poolAddress);
        if (!poolAccount) throw new Error(`Пул ${poolAddress.toBase58()} не найден`);
        const poolData: PoolData = this.program.coder.accounts.decode("Pool", poolAccount.data);

        console.log(`Структура poolData для пула ${poolAddress.toBase58()}:`, poolData);

        if (!poolData.poolBaseTokenAccount || !poolData.poolQuoteTokenAccount) {
            throw new Error(`Отсутствуют обязательные поля в poolData: poolBaseTokenAccount=${poolData.poolBaseTokenAccount}, poolQuoteTokenAccount=${poolData.poolQuoteTokenAccount}`);
        }

        const poolBaseAta = poolData.poolBaseTokenAccount;
        const poolQuoteAta = poolData.poolQuoteTokenAccount;

        let poolBaseAccount, poolQuoteAccount;
        try {
            [poolBaseAccount, poolQuoteAccount] = await Promise.all([
                getAccount(this.connection, poolBaseAta, 'confirmed'),
                getAccount(this.connection, poolQuoteAta, 'confirmed'),
            ]);
            if (!poolBaseAccount || !poolQuoteAccount) throw new Error("Недействительные токен-аккаунты пула");
        } catch (error) {
            console.log(`Ошибка проверки токен-аккаунтов пула ${poolAddress.toBase58()}: ${error}`);
            throw error;
        }

        const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], this.programId);
        const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], this.programId);
        const protocolFeeRecipient = new PublicKey('3sT3G8R9Y9eTdqaKDJUKnwrXJVeoMAdX8QAUHZwX5RRN');
        const protocolFeeRecipientAta = getAssociatedTokenAddressSync(quoteMint, protocolFeeRecipient, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

        const poolBaseReserves = new BN(poolBaseAccount.amount.toString());
        const poolQuoteReserves = new BN(poolQuoteAccount.amount.toString());
        const solLamports = new BN(amountSol.toString());
        const baseAmountOut = solLamports.mul(poolBaseReserves).div(poolQuoteReserves);
        const maxQuoteAmountIn = solLamports.mul(new BN(Math.floor(1 + slippage * 10000))).div(new BN(10000));

        console.log("Создание инструкции покупки:");
        console.log("Pool Address:", poolAddress.toBase58());
        console.log("User:", wallet.publicKey.toBase58());
        console.log("Base Mint:", tokenMint.toBase58());
        console.log("Quote Mint:", quoteMint.toBase58());
        console.log("Pool Base ATA:", poolBaseAta.toBase58());
        console.log("Pool Quote ATA:", poolQuoteAta.toBase58());
        console.log("Base Amount Out:", baseAmountOut.toString());
        console.log("Max Quote Amount In:", maxQuoteAmountIn.toString());

        return this.program.methods
            .buy(baseAmountOut, maxQuoteAmountIn)
            .accounts({
                pool: poolAddress,
                user: wallet.publicKey,
                global_config: globalConfig,
                base_mint: tokenMint,
                quote_mint: quoteMint,
                user_base_token_account: userBaseAta,
                user_quote_token_account: userQuoteAta,
                pool_base_token_account: poolBaseAta,
                pool_quote_token_account: poolQuoteAta,
                protocol_fee_recipient: protocolFeeRecipient,
                protocol_fee_recipient_token_account: protocolFeeRecipientAta,
                base_token_program: TOKEN_PROGRAM_ID,
                quote_token_program: TOKEN_PROGRAM_ID,
                system_program: PublicKey.default,
                associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
                event_authority: eventAuthority,
                program: this.programId,
            })
            .instruction();
    }

    async createSellInstruction(poolAddress: PublicKey, tokenMint: PublicKey, tokenAmount: bigint, wallet: Keypair, slippage: number = 0.25): Promise<TransactionInstruction> {
        const isValidPool = await this.validatePool(poolAddress);
        if (!isValidPool) {
            throw new Error(`Пул ${poolAddress.toBase58()} невалиден`);
        }

        const quoteMint = new PublicKey('So11111111111111111111111111111111111111112');
        const userBaseAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        const userQuoteAta = getAssociatedTokenAddressSync(quoteMint, wallet.publicKey, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

        const poolAccount = await this.connection.getAccountInfo(poolAddress);
        if (!poolAccount) throw new Error(`Пул ${poolAddress.toBase58()} не найден`);
        const poolData: PoolData = this.program.coder.accounts.decode("Pool", poolAccount.data);

        console.log(`Структура poolData для пула ${poolAddress.toBase58()}:`, poolData);

        if (!poolData.poolBaseTokenAccount || !poolData.poolQuoteTokenAccount) {
            throw new Error(`Отсутствуют обязательные поля в poolData: poolBaseTokenAccount=${poolData.poolBaseTokenAccount}, poolQuoteTokenAccount=${poolData.poolQuoteTokenAccount}`);
        }

        const poolBaseAta = poolData.poolBaseTokenAccount;
        const poolQuoteAta = poolData.poolQuoteTokenAccount;

        let poolBaseAccount, poolQuoteAccount;
        try {
            [poolBaseAccount, poolQuoteAccount] = await Promise.all([
                getAccount(this.connection, poolBaseAta, 'confirmed'),
                getAccount(this.connection, poolQuoteAta, 'confirmed'),
            ]);
            if (!poolBaseAccount || !poolQuoteAccount) throw new Error("Недействительные токен-аккаунты пула");
        } catch (error) {
            console.log(`Ошибка проверки токен-аккаунтов пула ${poolAddress.toBase58()}: ${error}`);
            throw error;
        }

        const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from("global_config")], this.programId);
        const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], this.programId);
        const protocolFeeRecipient = new PublicKey('3sT3G8R9Y9eTdqaKDJUKnwrXJVeoMAdX8QAUHZwX5RRN');
        const protocolFeeRecipientAta = getAssociatedTokenAddressSync(quoteMint, protocolFeeRecipient, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

        const poolBaseReserves = new BN(poolBaseAccount.amount.toString());
        const poolQuoteReserves = new BN(poolQuoteAccount.amount.toString());
        const baseAmountIn = new BN(tokenAmount.toString());
        const quoteAmountOut = baseAmountIn.mul(poolQuoteReserves).div(poolBaseReserves);
        const minQuoteAmountOut = quoteAmountOut.mul(new BN(Math.floor((1 - slippage) * 10000))).div(new BN(10000));

        console.log("Создание инструкции продажи:");
        console.log("Pool Address:", poolAddress.toBase58());
        console.log("User:", wallet.publicKey.toBase58());
        console.log("Base Mint:", tokenMint.toBase58());
        console.log("Quote Mint:", quoteMint.toBase58());
        console.log("Pool Base ATA:", poolBaseAta.toBase58());
        console.log("Pool Quote ATA:", poolQuoteAta.toBase58());
        console.log("Base Amount In:", baseAmountIn.toString());
        console.log("Min Quote Amount Out:", minQuoteAmountOut.toString());

        return this.program.methods
            .sell(baseAmountIn, minQuoteAmountOut)
            .accounts({
                pool: poolAddress,
                user: wallet.publicKey,
                global_config: globalConfig,
                base_mint: tokenMint,
                quote_mint: quoteMint,
                user_base_token_account: userBaseAta,
                user_quote_token_account: userQuoteAta,
                pool_base_token_account: poolBaseAta,
                pool_quote_token_account: poolQuoteAta,
                protocol_fee_recipient: protocolFeeRecipient,
                protocol_fee_recipient_token_account: protocolFeeRecipientAta,
                base_token_program: TOKEN_PROGRAM_ID,
                quote_token_program: TOKEN_PROGRAM_ID,
                system_program: PublicKey.default,
                associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
                event_authority: eventAuthority,
                program: this.programId,
            })
            .instruction();
    }
}