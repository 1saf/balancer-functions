import * as functions from 'firebase-functions';
import bent from 'bent';
import numeral from 'numeral';
import { startOfHour, format } from 'date-fns';
import Firestore from '@google-cloud/firestore';
import { chunk } from 'lodash';

export type GraphQLResponse<T> = { data: T };
export type EthBlockResponse = { id: string; number: string; timestamp: string };
export type EthBlocksResponse = GraphQLResponse<{ blocks: EthBlockResponse[] }>;
export type PoolData = {
    pools: {
        tokens: {
            balance: string;
            address: string;
            name: string;
            symbol: string;
        }[];
    }[];
};

export type TokenPrice = Record<string, { usd: number }>;

export const BALANCER_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer';

const PROJECTID = 'balancer-33c17';
const COLLECTION_NAME = 'dailydata';
const firestore = new Firestore.Firestore({
    projectId: PROJECTID,
    timestampsInSnapshots: true,
});
const POST = (url: string) => bent(url, 'POST', 'json', [200, 400, 404, 401, 500]);
const GET = (url: string) => bent(url, 'GET', 'json', [200, 400, 404, 401, 500])('');

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

export const calculateTokenLiquidity = functions.https.onRequest(async (req, res) => {
    const hour = startOfHour(new Date());
    const dateKey = format(hour, 'yyyyMMdd');

    const poolCountResponse = (await POST(BALANCER_SUBGRAPH_URL)('', { query: PoolCountQuery })) as GraphQLResponse<{
        balancer: { finalizedPoolCount: number };
    }>;

    const poolCount = Math.abs(poolCountResponse?.data?.balancer?.finalizedPoolCount);
    const poolCountWithMargin = poolCount + 1000;

    const iterations = Math.ceil(poolCountWithMargin / 1000);

    const promises = [...new Array(iterations)].map(async (_, i) => {
        const poolBalanceResponse = (await POST(BALANCER_SUBGRAPH_URL)('', { query: PoolsBalanceQuery(i) })) as GraphQLResponse<PoolData>;
        return poolBalanceResponse;
    });

    const resolvedResponses = await Promise.all(promises);
    const flattenedResponses = resolvedResponses.map(response => response.data.pools).flat();

    const balanceMap: Record<string, { name: string; liquidity: number; symbol: string; balance: number }> = {};
    const uniqueTokensMap: Record<string, string> = {};

    for (const response of flattenedResponses) {
        for (const token of response.tokens) {
            if (uniqueTokensMap[token.address]) continue;
            uniqueTokensMap[token.address] = token.symbol;
        }
    }

    const uniqueTokenAddresses = chunk(Object.keys(uniqueTokensMap), 100);
    const tokenPricesResponses = uniqueTokenAddresses.map(async addresses => {
        return (await GET(
            `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${addresses.join(',')}&vs_currencies=usd`
        )) as TokenPrice;
    });

    const resolvedTokenPricesResponses = await Promise.all(tokenPricesResponses);
    const tokenPrices = Object.assign.apply(Object, resolvedTokenPricesResponses as any);

    for (const response of flattenedResponses) {
        for (const token of response.tokens) {
            if (!tokenPrices || !tokenPrices[token?.address] || !tokenPrices[token?.address].usd) {
                console.error(`Could not find a tokenPrice for token ${token?.name} (${token.symbol}) [${token.address}]`);
            }

            const tokenPrice = tokenPrices[token?.address]?.usd || 0;

            tokenPrices[token?.symbol] = tokenPrice;

            if (balanceMap[token.symbol] !== undefined) {
                balanceMap[token.symbol].liquidity =
                    balanceMap[token.symbol].liquidity + numeral(token.balance).value() * tokenPrices[token.symbol];
            } else {
                balanceMap[token.symbol] = {
                    name: token.name,
                    liquidity: numeral(token.balance).value() * tokenPrices[token.symbol],
                    symbol: token.symbol,
                    balance: numeral(token.balance).value(),
                };
            }
        }
    }

    try {
        await firestore.collection(COLLECTION_NAME).doc(dateKey).set({ _v: 1 });
        for (const balances of chunk(Object.values(balanceMap), 500)) {
            const batch = firestore.batch();

            for (const balance of balances) {
                const docRef = firestore.collection(COLLECTION_NAME).doc(dateKey).collection('hourlytokendata').doc();
                batch.set(docRef, balance);
            }
            await batch.commit();
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Committing to db errored with' + error.message);
        res.json({ error });
    }
});
