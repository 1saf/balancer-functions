import * as functions from 'firebase-functions';
import numeral from 'numeral';
import { startOfHour, format, getUnixTime } from 'date-fns';
import { chunk } from 'lodash';
import { COLLECTION_NAME, firestore, GET, GraphQLResponse, POST } from './utils';
import { BALANCER_SUBGRAPH_URL } from '.';

export type Token = {
    balance: string;
    address: string;
    name: string;
    symbol: string;
    denormWeight: string;
}

export type Pool =  {
        id: string;
        totalSwapFee: string;
        totalSwapVolume: string;
        totalShares: string;
        tokens: Token[];
        liquidity: string;
        crp: boolean;
        controller: string;
}

export type PoolData = {
    pools: Pool[];
};

export type TokenPrice = Record<string, { usd: number }>;

const PoolCountQuery = `
query PoolCountQuery {
    balancer(id: "1") {
        finalizedPoolCount
    }
}
`;

const PoolsBalanceQuery = (i: number) => `
query PoolBalanceQuery {
    pools(first: 1000, skip: ${1000 * i}, where: {active: true}) {
        tokens {
            balance
            name
            symbol
            address
        }
    }
}
`;

type TokenDocument = {
    name: string;
    liquidity: number;
    symbol: string;
    balance: number;
    price: number;
    timestamp: number;
    contract_address: string;
};

export const calculateTokenLiquidity = functions.pubsub.schedule('0 0-23 * * *').onRun(async context => {
    const hour = startOfHour(new Date());
    const dateKey = format(hour, 'yyyyMMdd');

    functions.logger.log(`Beginning token liquidity calculation on ${dateKey}@${getUnixTime(hour)}`);
    try {
        // get number of pools on balancer
        const poolCountResponse = (await POST(BALANCER_SUBGRAPH_URL)('', { query: PoolCountQuery })) as GraphQLResponse<{
            balancer: { finalizedPoolCount: number };
        }>;

        const poolCount = Math.abs(poolCountResponse?.data?.balancer?.finalizedPoolCount);
        // add some padding to the poolcount just in case to grab
        // any stragglers that might not be covered by the finalised
        // pool count
        const poolCountWithMargin = poolCount + 1000;

        // how many requests to make
        const iterations = Math.ceil(poolCountWithMargin / 500);

        const promises = [...new Array(iterations)].map(async (_, i) => {
            const poolBalanceResponse = (await POST(BALANCER_SUBGRAPH_URL)('', { query: PoolsBalanceQuery(i) })) as GraphQLResponse<
                PoolData
            >;
            return poolBalanceResponse;
        });

        const resolvedResponses = await Promise.all(promises);

        const flattenedResponses = resolvedResponses.map(response => response?.data?.pools).flat();
        functions.logger.log(`Received pool counts from balancer.`);

        const balanceMap: Record<string, TokenDocument> = {};
        const uniqueTokensMap: Record<string, string> = {};

        for (const response of flattenedResponses) {
            for (const token of response?.tokens) {
                if (uniqueTokensMap[token.address]) continue;
                uniqueTokensMap[token.address] = token.symbol;
            }
        }

        functions.logger.log(`Beginning coingecko price accumulation.`);
        // coingecko has a limit on how many tokens you can request at a single time
        const uniqueTokenAddresses = chunk(Object.keys(uniqueTokensMap), 100);
        const tokenPricesResponses = uniqueTokenAddresses.map(async addresses => {
            return (await GET(
                `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${addresses.join(',')}&vs_currencies=usd`
            )) as TokenPrice;
        });

        const resolvedTokenPricesResponses = await Promise.all(tokenPricesResponses);
        const tokenPrices = Object.assign.apply(Object, resolvedTokenPricesResponses as any);

        functions.logger.log(`Calculating token liquidity.`);

        for (const response of flattenedResponses) {
            for (const token of response.tokens) {
                // no coingecko price, do nothing
                if (!tokenPrices || !tokenPrices[token?.address] || !tokenPrices[token?.address].usd) {
                    continue;
                }
                const tokenPrice = tokenPrices[token?.address]?.usd || 0;
                tokenPrices[token?.symbol] = tokenPrice;

                // sum up all the liquidity values
                if (balanceMap[token.symbol] !== undefined) {
                    balanceMap[token.symbol].liquidity =
                        balanceMap[token.symbol].liquidity + numeral(token.balance).value() * tokenPrices[token.symbol];
                    balanceMap[token.symbol].balance = balanceMap[token.symbol].balance + numeral(token.balance).value();
                } else {
                    balanceMap[token.symbol] = {
                        name: token.name,
                        liquidity: numeral(token.balance).value() * tokenPrices[token.symbol],
                        symbol: token.symbol,
                        balance: numeral(token.balance).value(),
                        price: tokenPrices[token.symbol],
                        timestamp: getUnixTime(hour),
                        contract_address: token.address,
                    };
                }
            }
        }

        functions.logger.log(`Committing to DB.`);

        await firestore.collection(COLLECTION_NAME).doc(dateKey).set({ _v: 1 });
        for (const balances of chunk(Object.values(balanceMap), 500)) {
            const batch = firestore.batch();

            for (const balance of balances) {
                const docRef = firestore.collection(COLLECTION_NAME).doc(dateKey).collection('hourlytokendata').doc();
                batch.set(docRef, balance);
            }
            await batch.commit();
        }
        functions.logger.log(`Success.`);
    } catch (error) {
        functions.logger.error(`Failed to run whole function ${error.message}`);
    }
});
