import * as functions from 'firebase-functions';
import bent from 'bent';
import { addMinutes, startOfHour, getUnixTime, format } from 'date-fns';
import { calculateTokenLiquidity as _calculateTokenLiquidity } from './token_liquidity';

export type GraphQLResponse<T> = { data: T };
export type EthBlockResponse = { id: string; number: string; timestamp: string };
export type EthBlocksResponse = GraphQLResponse<{ blocks: EthBlockResponse[] }>;
export type BalancerData = {
    balancer: {
        finalizedPoolCount: number;
        poolCount: number;
        totalLiquidity: string;
        totalSwapFee: string;
        totalSwapVolume: string;
        txCount: number;
    };
};

import Firestore from '@google-cloud/firestore';
const PROJECTID = 'balancer-33c17';
const COLLECTION_NAME = 'dailydata';
const firestore = new Firestore.Firestore({
    projectId: PROJECTID,
    timestampsInSnapshots: true,
});

export const BALANCER_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer';
export const ETH_BLOCKS_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/blocklytics/ethereum-blocks';

const POST = (url: string) => bent(url, 'POST', 'json', [200, 400, 404, 401, 500]);

export const calculateTokenLiquidity = _calculateTokenLiquidity;
export const pullBalancerData = functions.https.onRequest(async (req, res) => {
    const hourStart = startOfHour(new Date());
    const tenMinutesLater = addMinutes(hourStart, 10);

    const ethBlocksQuery = `
    query blocksTimestampsQuery {
        blocks(first: 1, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${getUnixTime(
            hourStart
        )}, timestamp_lt: ${getUnixTime(tenMinutesLater)} }) {
            id
            number
            timestamp
        }
    }`;

    const ethBlocksResponse = (await POST(ETH_BLOCKS_SUBGRAPH_URL)('', { query: ethBlocksQuery })) as EthBlocksResponse;
    const block = ethBlocksResponse?.data?.blocks[0];

    if (!block || !block?.number) throw new Error(`Could not find block`);

    const historicalBalancerQuery = `
    query HistoricalBalancerQuery {
        balancer(id: 1, block: { number: ${block?.number} }) {
            poolCount,
            txCount,
            totalLiquidity,
            totalSwapVolume,
            totalSwapFee
            finalizedPoolCount
        }
    }
    `;

    const historicalBalancerResponse = (await POST(BALANCER_SUBGRAPH_URL)('', { query: historicalBalancerQuery })) as GraphQLResponse<
        BalancerData
    >;

    try {
        await firestore
            .collection(COLLECTION_NAME)
            .doc(format(hourStart, 'yyyyMMdd'))
            .set({ _v: 1 })

        const result = await firestore
            .collection(COLLECTION_NAME)
            .doc(format(hourStart, 'yyyyMMdd'))
            .collection('hourlydata')
            .add({
                ...historicalBalancerResponse?.data?.balancer,
                timestamp: getUnixTime(hourStart),
            });
        res.json({ result });
    } catch (error) {
        res.json({ error });
    }
});
