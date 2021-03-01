import * as functions from 'firebase-functions';
import {
    BALANCER_SUBGRAPH_URL,
    EthBlocksResponse,
    firestore,
    GraphQLResponse,
    POST,
} from './utils';
import { ETH_BLOCKS_SUBGRAPH_URL } from './';
import { PoolData } from './token_liquidity';
import {
    addMinutes,
    getUnixTime,
    startOfHour,
    subDays,
    subHours,
} from 'date-fns';
import { chunk, keyBy } from 'lodash';
import numeral from 'numeral';
import { multicall } from './ethers/multicall';
import { provider } from './ethers/provider';
import ConfigurableRightsPoolContract from './ethers/ConfigurableRightsPool';
import { BigNumberish } from '@ethersproject/bignumber';
import { formatFixed } from '@ethersproject/bignumber';

const names = ['wei', 'kwei', 'mwei', 'gwei', 'szabo', 'finney', 'ether'];

const PoolCountQuery = `
query PoolCountQuery {
    balancer(id: "1") {
        finalizedPoolCount
    }
}
`;

const PoolsDataQuery = (i: number, blockNumber?: string) => {
    const blockClause =
        blockNumber !== 'latest' ? `, block: { number: ${blockNumber} }` : '';
    return `
        query PoolBalanceQuery {
            pools(first: 1000, skip: ${
                1000 * i
            }, where: {active: true, publicSwap: true }${blockClause}) {
                id
                totalSwapVolume
                totalSwapFee
                totalShares
                liquidity
                crp
                controller
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
};

const ethBlocksQuery = (date: Date) => {
    const hourStart = startOfHour(date);
    const tenMinutesLater = addMinutes(date, 10);
    return `
        query blocksTimestampsQuery {
            blocks(first: 1, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${getUnixTime(
                hourStart
            )}, timestamp_lt: ${getUnixTime(tenMinutesLater)} }) {
                id
                number
                timestamp
            }
        }`;
};

const getPoolsByDate = async (date?: Date) => {
    let blockNumber = 'latest';
    let timestamp = null;
    if (date) {
        const ethBlockResponse = ((await POST(ETH_BLOCKS_SUBGRAPH_URL)('', {
            query: ethBlocksQuery(date),
        })) as EthBlocksResponse).data.blocks[0];
        blockNumber = ethBlockResponse.number;
        timestamp = numeral(ethBlockResponse.timestamp).value();
    }

    // get number of pools on balancer
    const poolCountResponse = (await POST(BALANCER_SUBGRAPH_URL)('', {
        query: PoolCountQuery,
    })) as GraphQLResponse<{
        balancer: { finalizedPoolCount: number };
    }>;

    const poolCount = Math.abs(
        poolCountResponse?.data?.balancer?.finalizedPoolCount
    );

    console.info(
        `Found ${poolCount} pools for block ${blockNumber} on balancer.`
    );

    // add some padding to the poolcount just in case to grab
    // any stragglers that might not be covered by the finalised
    // pool count
    const poolCountWithMargin = poolCount + 1000;

    // how many requests to make
    const iterations = Math.ceil(poolCountWithMargin / 500);

    const promises = [...new Array(iterations)].map(async (_, i) => {
        const poolBalanceResponse = (await POST(BALANCER_SUBGRAPH_URL)('', {
            query: PoolsDataQuery(i, blockNumber),
        })) as GraphQLResponse<PoolData>;
        return poolBalanceResponse;
    });

    console.info(`Resolved pool data from subgraph for block ${blockNumber}.`);

    const resolvedResponses = await Promise.all(promises);
    const flattenedResponses = resolvedResponses
        .map((response) => response?.data?.pools)
        .flat();

    return {
        pools: flattenedResponses,
        timestamp,
    };
};

// const getTokenPriceCache = async (pools: Pool[]) => {
//     const uniqueTokensMap: Record<string, string> = {};

//     for (const pool of pools) {
//         for (const token of pool?.tokens) {
//             if (uniqueTokensMap[token.address]) continue;
//             uniqueTokensMap[token.address] = token.symbol;
//         }
//     }

//     functions.logger.log(`Beginning coingecko price accumulation.`);
//     // coingecko has a limit on how many tokens you can request at a single time
//     const uniqueTokenAddresses = chunk(Object.keys(uniqueTokensMap), 100);
//     const tokenPricesResponses = uniqueTokenAddresses.map(async (addresses) => {
//         return (await GET(
//             `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${addresses.join(
//                 ","
//             )}&vs_currencies=usd`
//         )) as TokenPrice;
//     });

//     const resolvedTokenPricesResponses = await Promise.all(
//         tokenPricesResponses
//     );
//     const tokenPrices = Object.assign.apply(
//         Object,
//         resolvedTokenPricesResponses as any
//     );
//     return tokenPrices as Record<string, { usd: number }>;
// };

// const getBPTPrice = (
//     tokenPrices: Record<string, { usd: number }>,
//     tokens: Token[],
//     totalShares: string
// ) => {
//     let totalBalance = 0;
//     for (const token of tokens) {
//         const tokenPrice = tokenPrices[token.address];
//         if (tokenPrices !== undefined) {
//             totalBalance += tokenPrice?.usd * numeral(token.balance).value();
//         }
//     }
//     return totalBalance / numeral(totalShares).value();
// };

export function formatUnits(
    value: BigNumberish,
    unitName?: string | BigNumberish
): string {
    if (typeof unitName === 'string') {
        const index = names.indexOf(unitName);
        if (index !== -1) {
            unitName = 3 * index;
        }
    }
    return formatFixed(value, unitName != null ? unitName : 18);
}

export const indexPoolData = functions
    .runWith({ timeoutSeconds: 540 })
    .pubsub.schedule('0 0-23 * * *')
    .onRun(async () => {
        try {
            const yesterday = startOfHour(subHours(new Date(), 24));
            const thirtyDaysAgo = startOfHour(subDays(new Date(), 30));

            console.info('Beginning to index pools data.');

            const todayPoolsData = await getPoolsByDate();
            const yesterdayPoolsData = await getPoolsByDate(yesterday);
            const thirtyDayPoolsData = await getPoolsByDate(thirtyDaysAgo);

            const yesterdayPoolsMap = keyBy(yesterdayPoolsData.pools, 'id');
            const thirtyDayPoolsMap = keyBy(thirtyDayPoolsData.pools, 'id');
            // const tokenPrices = await getTokenPriceCache(todayPoolsData.pools);

            // batch can only process 500 at a time
            for (const responseChunk of chunk(todayPoolsData.pools, 500)) {
                const batch = firestore.batch();

                for (const pool of responseChunk) {
                    const poolName = pool.tokens
                        .map((token) => {
                            return `${
                                numeral(token?.denormWeight).value() * 2
                            }% ${token?.symbol}`;
                        })
                        .join(' / ');

                    let totalShares = numeral(pool.totalShares).value();
                    if (totalShares === 0) {
                        const address = pool.crp ? pool.controller : pool.id;
                        console.log(
                            `Pool ${pool.id}[CRP: ${pool.crp}] has 0 total shares, fetching from smart contract using ${address}`
                        );
                        const poolContractData = await multicall(
                            provider,
                            ConfigurableRightsPoolContract.abi,
                            ['totalSupply', 'decimals'].map((method) => [
                                address,
                                method,
                                [],
                            ])
                        );
                        const decimals = poolContractData[0][1];
                        totalShares = numeral(
                            formatUnits(poolContractData[0][0], decimals)
                        ).value();

                        console.log(
                            `Total shares for pool ${pool.id} from smart contract: ${totalShares}`
                        );
                    }

                    let bptPrice =
                        numeral(pool.liquidity).value() / totalShares;

                    let historicalBptPrice = -1;
                    if (thirtyDayPoolsMap[pool.id]) {
                        historicalBptPrice = numeral(thirtyDayPoolsMap[pool.id].liquidity).value() / totalShares;
                    }

                    // our way of signalling the pool has no bpt price
                    if (totalShares === 0) bptPrice = -1;

                    let returns30D = -1;

                    if (bptPrice > 0 && historicalBptPrice > 0) {
                        returns30D = ((bptPrice - historicalBptPrice) / historicalBptPrice);
                    }

                    const docRef = firestore.collection('poolDataCache').doc(pool.id);

                    const document = {
                        poolName,
                        id: pool.id,
                        totalSwapFee: pool.totalSwapFee,
                        totalSwapVolume: pool.totalSwapVolume,
                        timestamp:
                            todayPoolsData.timestamp || getUnixTime(new Date()),
                        swapFeeVolume24: numeral(pool.totalSwapFee).value(),
                        swapVolume24: numeral(pool.totalSwapVolume).value(),
                        bptPrice,
                        totalShares,
                        liquidity: pool.liquidity,
                        returns30D,
                        historicalBptPrice,
                    };

                    if (yesterdayPoolsMap[pool.id]) {
                        document.swapFeeVolume24 = numeral(pool.totalSwapFee)
                            .subtract(
                                numeral(
                                    yesterdayPoolsMap[pool.id].totalSwapFee
                                ).value()
                            )
                            .value();
                        document.swapVolume24 = numeral(pool.totalSwapVolume)
                            .subtract(
                                numeral(
                                    yesterdayPoolsMap[pool.id].totalSwapVolume
                                ).value()
                            )
                            .value();
                    }

                    batch.set(docRef, document);
                }
                console.info(`Comitting to db.`);
                await batch.commit();
            }
            console.info(`Completed indexing pool data.`);
        } catch (error) {
            console.log(error);
        }
    });
