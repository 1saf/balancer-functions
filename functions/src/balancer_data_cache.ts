import { addMinutes, eachHourOfInterval, format, fromUnixTime, getUnixTime, startOfDay, startOfHour } from 'date-fns';
import * as functions from 'firebase-functions';
import { ETH_BLOCKS_SUBGRAPH_URL } from '.';
import { BALANCER_SUBGRAPH_URL, COLLECTION_NAME, EthBlocksResponse, firestore, POST, GraphQLResponse } from './utils';
// import Firestore from '@google-cloud/firestore';

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

const REBUILD = true;
export const BALANCER_CONTRACT_START_DATE = new Date(2020, 2, 29);
export const TODAY = startOfDay(new Date());

export const pullBalancerData = functions.runWith({ timeoutSeconds: 240 }).https.onRequest(async (req, res) => {
    const hourStart = startOfHour(new Date());
    const tenMinutesLater = addMinutes(hourStart, 10);

    const ethBlocksQuery = (hourStart: Date, tenMinutesLater: Date) => `
    query blocksTimestampsQuery {
        blocks(first: 1, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${getUnixTime(
            hourStart
        )}, timestamp_lt: ${getUnixTime(tenMinutesLater)} }) {
            id
            number
            timestamp
        }
    }`;

    const historicalBalancerQuery = (blockNumber: string) => `
    query HistoricalBalancerQuery {
        balancer(id: 1, block: { number: ${blockNumber} }) {
            poolCount,
            txCount,
            totalLiquidity,
            totalSwapVolume,
            totalSwapFee
            finalizedPoolCount
        }
    }
    `;

    if (REBUILD) {
        let dates = [];
        dates = eachHourOfInterval({ start: BALANCER_CONTRACT_START_DATE, end: TODAY }).map(date => ({
            first_ten: date,
            last_ten: addMinutes(date, 10),
        }));

        console.log('lool', dates);


        const ethBlocksResponses = dates.map(async date => {
            return (await POST(ETH_BLOCKS_SUBGRAPH_URL)('', { query: ethBlocksQuery(date.first_ten, date.last_ten) })) as EthBlocksResponse;
        });

        console.log('lool', ethBlocksResponses);


        const resolvedEthBlocksResponses = await Promise.all(ethBlocksResponses);

        const blocks = resolvedEthBlocksResponses.map(blocks => ({
            number: blocks.data.blocks[0].number,
            timestamp: blocks.data.blocks[0].timestamp,
        }));

        console.log('food', blocks);

        const balancerResponses = blocks.map(
            async block =>
                ({
                    ...(await POST(BALANCER_SUBGRAPH_URL)('', { query: historicalBalancerQuery(block.number) })) as GraphQLResponse<BalancerData>,
                    timestamp: block.timestamp,
                })
        );

        const resolvedBalancerResponses = await Promise.all(balancerResponses);
        for (const response of resolvedBalancerResponses) {
            const hour = fromUnixTime(parseInt(response.timestamp, 10));
            await firestore.collection(COLLECTION_NAME).doc(format(hour, 'yyyyMMdd')).set({ _v: 1 });

            await firestore
                .collection(COLLECTION_NAME)
                .doc(format(hour, 'yyyyMMdd'))
                .collection('hourlydata')
                .add(response);
        }

        res.json({ success: true });
        return;
    }

    const ethBlocksResponse = (await POST(ETH_BLOCKS_SUBGRAPH_URL)('', {
        query: ethBlocksQuery(hourStart, tenMinutesLater),
    })) as EthBlocksResponse;
    const block = ethBlocksResponse?.data?.blocks[0];

    if (!block || !block?.number) throw new Error(`Could not find block`);

    const historicalBalancerResponse = (await POST(BALANCER_SUBGRAPH_URL)('', {
        query: historicalBalancerQuery(block.number),
    })) as GraphQLResponse<BalancerData>;

    try {
        await firestore.collection(COLLECTION_NAME).doc(format(hourStart, 'yyyyMMdd')).set({ _v: 1 });

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
