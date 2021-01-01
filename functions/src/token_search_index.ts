import * as functions from 'firebase-functions';
import algoliasearch from 'algoliasearch';
import { format, getUnixTime, startOfHour } from 'date-fns';
import { firestore } from './utils';

const ALGOLIA_ID = functions.config().algolia.app_id;
const ALGOLIA_ADMIN_KEY = functions.config().algolia.api_key;

const ALGOLIA_INDEX_NAME = 'prod_Token_Search_Index';
const client = algoliasearch(ALGOLIA_ID, ALGOLIA_ADMIN_KEY);

export const indexTokenNames = functions.pubsub.schedule('3 0-23 * * *').onRun(async () => {
    const hour = startOfHour(new Date());
    const hourTimestamp = getUnixTime(hour);
    const dateKey = format(hour, 'yyyyMMdd');

    const docsToIndexRef = await firestore
        .collection('dailydata')
        .doc(dateKey)
        .collection('hourlytokendata')
        .where('timestamp', '==', hourTimestamp)
        .get();

    for (const doc of docsToIndexRef.docs) {
        const tokenData = doc.data();

        // Add an 'objectID' field which Algolia requires
        tokenData.objectID = tokenData.symbol;

        // Write to the algolia index
        const index = client.initIndex(ALGOLIA_INDEX_NAME);
        await index.saveObject(tokenData);
    }
});
