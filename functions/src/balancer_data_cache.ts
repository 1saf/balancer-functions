import { addMinutes, eachHourOfInterval, format, fromUnixTime, getUnixTime, startOfDay, startOfHour, subHours } from 'date-fns';
import * as functions from 'firebase-functions';
import { chunk } from 'lodash';
import { ETH_BLOCKS_SUBGRAPH_URL } from '.';
import { BALANCER_SUBGRAPH_URL, COLLECTION_NAME, EthBlocksResponse, firestore, POST, GraphQLResponse } from './utils';

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

const REBUILD = false;
export const BALANCER_CONTRACT_START_DATE = startOfDay(new Date(2020, 1, 29));
export const TODAY = startOfHour(new Date());

export const pullBalancerData = functions.runWith({ timeoutSeconds: 540 }).pubsub.schedule('0 0-23 * * *').onRun(async context => {
    const hourStart = startOfHour(subHours(new Date(), 1));
    const tenMinutesLater = addMinutes(hourStart, 10);

    const ethBlocksQuery = (_hourStart: Date, _tenMinutesLater: Date) => `
    query blocksTimestampsQuery {
        blocks(first: 1, orderBy: timestamp, orderDirection: asc, where: { timestamp_gt: ${getUnixTime(
        _hourStart
    )}, timestamp_lt: ${getUnixTime(_tenMinutesLater)} }) {
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
        dates = eachHourOfInterval({ start: BALANCER_CONTRACT_START_DATE, end: TODAY }).map(_date => ({
            first_ten: _date,
            last_ten: addMinutes(_date, 10),
        }));

        const dateChunks = chunk(dates, 500);

        for (const chunkedDates of dateChunks) {
            const ethBlocksResponses = chunkedDates.map(async date => {
                return (await POST(ETH_BLOCKS_SUBGRAPH_URL)('', { query: ethBlocksQuery(date.first_ten, date.last_ten) })) as EthBlocksResponse;
            });
            const resolvedEthBlocksResponses = await Promise.all(ethBlocksResponses);

            const blocks = resolvedEthBlocksResponses.map(_blocks => ({
                number: _blocks.data.blocks[0].number,
                timestamp: _blocks.data.blocks[0].timestamp,
            }));

            const balancerResponses = blocks.map(
                async _block =>
                ({
                    ...((await POST(BALANCER_SUBGRAPH_URL)('', { query: historicalBalancerQuery(_block.number) })) as GraphQLResponse<BalancerData>).data.balancer,
                    timestamp: _block.timestamp,
                })
            );

            const resolvedBalancerResponses = await Promise.all(balancerResponses);

            const batch = firestore.batch();
            for (const response of resolvedBalancerResponses) {
                const hour = fromUnixTime(parseInt(response.timestamp, 10));
                await firestore.collection(COLLECTION_NAME).doc(format(hour, 'yyyyMMdd')).set({ _v: 1 });

                const docRef = firestore
                    .collection(COLLECTION_NAME)
                    .doc(format(hour, 'yyyyMMdd'))
                    .collection('hourlydata')
                    .doc();
                
                batch.set(docRef, response);
            }

            await batch.commit();
        }
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

        await firestore
            .collection(COLLECTION_NAME)
            .doc(format(hourStart, 'yyyyMMdd'))
            .collection('hourlydata')
            .add({
                ...historicalBalancerResponse?.data?.balancer,
                timestamp: getUnixTime(hourStart),
            });
    } catch (error) {
        console.error(error.message);
    }
});
