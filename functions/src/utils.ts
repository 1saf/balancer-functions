import Firestore from '@google-cloud/firestore';
import bent from 'bent';


export type GraphQLResponse<T> = { data: T };
export type EthBlockResponse = { id: string; number: string; timestamp: string };
export type EthBlocksResponse = GraphQLResponse<{ blocks: EthBlockResponse[] }>;
export const BALANCER_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer';

export const PROJECTID = 'balancer-33c17';
export const COLLECTION_NAME = 'dailydata';
export const firestore = new Firestore.Firestore({
    projectId: PROJECTID,
    timestampsInSnapshots: true,
});
export const POST = (url: string) => bent(url, 'POST', 'json', [200, 400, 404, 401, 500]);
export const GET = (url: string) => bent(url, 'GET', 'json', [200, 400, 404, 401, 500])('');