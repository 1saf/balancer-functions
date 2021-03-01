import * as functions from 'firebase-functions';
import numeral from 'numeral';
import { COLLECTION_NAME, firestore } from './utils';

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

export const convertTimestamps = functions.runWith({ timeoutSeconds: 540 }).pubsub.schedule('0 0-23 * * *').onRun(async context => {
    try {
        const dailyData = await firestore.collection(COLLECTION_NAME).get();

        for (const day of dailyData.docs) {
            const hourlyData = await day.ref.collection('hourlydata').get();

            for (const hourData of hourlyData.docs) {
                let _timestamp = (await hourData.data()).timestamp;
                const numericalTimestamp = numeral(_timestamp).value();
                await hourData.ref.update({ timestamp: numericalTimestamp });
            }
        }

    } catch (error) {
        console.error(error.message);
    }
});
