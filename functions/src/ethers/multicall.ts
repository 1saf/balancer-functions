import { Interface } from '@ethersproject/abi';
import { Contract } from '@ethersproject/contracts';
import multicallContract from './MulticallContract';

const MULTICALL_ADDRESS = '0xeefBa1e63905eF1D7ACbA5a8513c70307C1cE441';

export async function multicall(provider: any, abi: any, calls: any, options?: any) {
    const multi = new Contract(MULTICALL_ADDRESS, multicallContract.abi, provider);

    const itf = new Interface(abi);
    try {
        const [, response] = await multi.aggregate(
            calls.map((call: any) => [
                call[0].toLowerCase(),
                itf.encodeFunctionData(call[1], call[2]),
            ]),
            options || {});
        return response.map((call: any, i: number) =>
            itf.decodeFunctionResult(calls[i][1], call)
        );
    } catch (e) {
        return Promise.reject(e);
    }
}