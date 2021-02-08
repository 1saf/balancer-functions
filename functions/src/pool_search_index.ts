import * as functions from 'firebase-functions';
import algoliasearch from 'algoliasearch';
import { BALANCER_SUBGRAPH_URL, GraphQLResponse, POST } from './utils';
import { PoolData } from './token_liquidity';
import numeral from 'numeral';

const ALGOLIA_ID = functions.config().algolia.app_id;
const ALGOLIA_ADMIN_KEY = functions.config().algolia.api_key;

const ALGOLIA_INDEX_NAME = 'prod_Pools_Search_Index';
const client = algoliasearch(ALGOLIA_ID, ALGOLIA_ADMIN_KEY);

const PoolCountQuery = `
query PoolCountQuery {
    balancer(id: "1") {
        finalizedPoolCount
    }
}
`;

const PoolsNameQuery = (i: number) => `
query PoolBalanceQuery {
    pools(first: 1000, skip: ${1000 * i}, where: {active: true}) {
        id
        tokens {
            balance
            name
            symbol
            address
            denormWeight
        }
    }
}
`;

export const indexPoolNames = functions.pubsub.schedule('0 0-23 * * *').onRun(async () => {
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
        const poolBalanceResponse = (await POST(BALANCER_SUBGRAPH_URL)('', { query: PoolsNameQuery(i) })) as GraphQLResponse<PoolData>;
        return poolBalanceResponse;
    });

    const resolvedResponses = await Promise.all(promises);
    const flattenedResponses = resolvedResponses.map(response => response?.data?.pools).flat();

    const poolNames = flattenedResponses.map((pool) => {
        return {
            id: pool.id,
            name: pool.tokens.map((token) => {
                return `${numeral(token?.denormWeight).value() * 2}% ${token?.symbol}`
            }).join(' / ')
        }
    });

    for (const pool of poolNames) {
        const _pool: any = {
            ...pool,
        };

        // Add an 'objectID' field which Algolia requires
        _pool.objectID = _pool.id;

        // Write to the algolia index
        const index = client.initIndex(ALGOLIA_INDEX_NAME);
        await index.saveObject(_pool);
    }
});
