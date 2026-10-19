/**
 * Map `fn` over `items` with at most `limit` calls in flight.
 *
 * Results come back in INPUT order whatever order the calls finish in, so a
 * caller merging them gets deterministic output. The first rejection rejects
 * the whole call and no further item is started; calls already in flight run
 * to completion (a promise cannot be cancelled), their results discarded.
 *
 * @template T, R
 * @param {Iterable<T>} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapPool(items, limit, fn) {
    const list = Array.from(items ?? []);
    const results = new Array(list.length);
    const width = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, list.length || 1));
    let next = 0;
    let failed = false;

    const worker = async () => {
        while (!failed && next < list.length) {
            const i = next++;
            try {
                results[i] = await fn(list[i], i);
            } catch (e) {
                failed = true;
                throw e;
            }
        }
    };

    await Promise.all(Array.from({ length: width }, worker));
    return results;
}

export default { mapPool };
