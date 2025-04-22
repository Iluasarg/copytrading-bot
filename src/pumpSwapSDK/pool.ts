import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, LAMPORTS_PER_SOL, PublicKey, Keypair } from "@solana/web3.js";
import { IDL } from "./IDL";

const PUMP_AMM_PROGRAM_ID: PublicKey = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_TOKEN_ACCOUNT: PublicKey = new PublicKey('So11111111111111111111111111111111111111112');

const dummyKeypair = Keypair.generate();
const dummyWallet: Wallet = {
    publicKey: dummyKeypair.publicKey,
    payer: dummyKeypair,
    signTransaction: async () => { throw new Error("No wallet provided for signing"); },
    signAllTransactions: async () => { throw new Error("No wallet provided for signing"); },
};

export interface Pool {
    address: PublicKey;
    is_native_base: boolean;
    poolData: any;
}

export interface PoolWithPrice extends Pool {
    price: number;
    reserves: {
        native: number;
        token: number;
    }
}

const getPoolsWithBaseMint = async (connection: Connection, mintAddress: PublicKey) => {
    const response = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
        filters: [
            { "dataSize": 211 },
            {
                "memcmp": {
                    "offset": 43,
                    "bytes": mintAddress.toBase58()
                }
            }
        ]
    });

    const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" });
    const program = new Program(IDL, PUMP_AMM_PROGRAM_ID, provider);

    const mappedPools = response.map((pool) => {
        const data = Buffer.from(pool.account.data);
        const poolData = program.coder.accounts.decode('pool', data);
        return {
            address: pool.pubkey,
            is_native_base: false,
            poolData
        };
    });

    return mappedPools;
};

const getPoolsWithQuoteMint = async (connection: Connection, mintAddress: PublicKey) => {
    const response = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
        filters: [
            { "dataSize": 211 },
            {
                "memcmp": {
                    "offset": 75,
                    "bytes": mintAddress.toBase58()
                }
            }
        ]
    });

    const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" });
    const program = new Program(IDL, PUMP_AMM_PROGRAM_ID, provider);

    const mappedPools = response.map((pool) => {
        const data = Buffer.from(pool.account.data);
        const poolData = program.coder.accounts.decode('pool', data);
        return {
            address: pool.pubkey,
            is_native_base: true,
            poolData
        };
    });

    return mappedPools;
};

const getPoolsWithBaseMintQuoteWSOL = async (connection: Connection, mintAddress: PublicKey) => {
    const response = await connection.getProgramAccounts(PUMP_AMM_PROGRAM_ID, {
        filters: [
            { "dataSize": 211 },
            {
                "memcmp": {
                    "offset": 43,
                    "bytes": mintAddress.toBase58()
                }
            },
            {
                "memcmp": {
                    "offset": 75,
                    "bytes": WSOL_TOKEN_ACCOUNT.toBase58()
                }
            }
        ]
    });

    const provider = new AnchorProvider(connection, dummyWallet, { commitment: "confirmed" });
    const program = new Program(IDL, PUMP_AMM_PROGRAM_ID, provider);

    const mappedPools = response.map((pool) => {
        const data = Buffer.from(pool.account.data);
        const poolData = program.coder.accounts.decode('pool', data);
        return {
            address: pool.pubkey,
            is_native_base: true,
            poolData
        };
    });

    return mappedPools;
};

export const getPriceAndLiquidity = async (connection: Connection, pool: Pool): Promise<PoolWithPrice | null> => {
    const wsolAddress = pool.poolData.poolQuoteTokenAccount;
    const tokenAddress = pool.poolData.poolBaseTokenAccount;

    try {
        const [wsolBalance, tokenBalance] = await Promise.all([
            connection.getTokenAccountBalance(wsolAddress),
            connection.getTokenAccountBalance(tokenAddress),
        ]);

        if (!wsolBalance.value.uiAmount || !tokenBalance.value.uiAmount) {
            console.log(`Нулевой баланс в пуле ${pool.address.toBase58()}: wsol=${wsolBalance.value.uiAmount}, token=${tokenBalance.value.uiAmount}`);
            return null;
        }

        const price = wsolBalance.value.uiAmount / tokenBalance.value.uiAmount;
        console.log(`Балансы для пула ${pool.address.toBase58()}: wsol=${wsolBalance.value.uiAmount}, token=${tokenBalance.value.uiAmount}, цена=${price}`);

        return {
            ...pool,
            price,
            reserves: {
                native: wsolBalance.value.uiAmount,
                token: tokenBalance.value.uiAmount,
            },
        };
    } catch (error) {
        console.log(`Ошибка получения цены и ликвидности для пула ${pool.address.toBase58()}: ${error}`);
        return null;
    }
};

const getPoolsWithPrices = async (connection: Connection, mintAddress: PublicKey) => {
    const [poolsWithBaseMint, poolsWithQuoteMint] = await Promise.all([
        getPoolsWithBaseMint(connection, mintAddress),
        getPoolsWithQuoteMint(connection, mintAddress),
    ]);
    const pools = [...poolsWithBaseMint, ...poolsWithQuoteMint];

    if (pools.length === 0) {
        console.log(`Нет пулов для mint: ${mintAddress.toBase58()}`);
        return [];
    }

    const results = await Promise.all(pools.map(pool => getPriceAndLiquidity(connection, pool)));
    const validResults = results.filter((result): result is PoolWithPrice => result !== null);
    const sortedByHighestLiquidity = validResults.sort((a, b) => b.reserves.native - a.reserves.native);

    return sortedByHighestLiquidity;
};

export const calculateWithSlippageBuy = (amount: bigint, basisPoints: bigint) => {
    return amount - (amount * basisPoints) / 10000n;
};

export const getBuyTokenAmount = async (connection: Connection, solAmount: bigint, mint: PublicKey) => {
    const pool_detail = await getPoolsWithPrices(connection, mint);
    if (pool_detail.length === 0) {
        console.log(`Не удалось найти пул для mint: ${mint.toBase58()}`);
        return 0n;
    }
    const sol_reserve = BigInt(pool_detail[0].reserves.native * LAMPORTS_PER_SOL);
    const token_reserve = BigInt(pool_detail[0].reserves.token * 10 ** 6);
    const product = sol_reserve * token_reserve;
    let new_sol_reserve = sol_reserve + solAmount;
    let new_token_reserve = product / new_sol_reserve + 1n;
    let amount_to_be_purchased = token_reserve - new_token_reserve;

    return amount_to_be_purchased;
};

export const getPumpSwapPool = async (connection: Connection, mint: PublicKey): Promise<Pool | null> => {
    const pools = await getPoolsWithBaseMintQuoteWSOL(connection, mint);
    if (pools.length === 0) {
        console.log(`Не удалось найти пул для mint: ${mint.toBase58()}`);
        return null;
    }
    return pools[0];
};

export const getPrice = async (connection: Connection, mint: PublicKey) => {
    const pools = await getPoolsWithPrices(connection, mint);
    if (pools.length === 0) {
        throw new Error(`No pools found for mint: ${mint.toBase58()}`);
    }
    return pools[0].price;
};