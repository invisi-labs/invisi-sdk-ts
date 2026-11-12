/** Preserve statement order while limiting independent read/encryption work in flight. */
export async function mapPreparation<T, R>(
    values: readonly T[],
    work: (value: T, index: number) => Promise<R>
): Promise<R[]> {
    const output = new Array<R>(values.length);
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(4, values.length) }, async () => {
            while (cursor < values.length) {
                const index = cursor++;
                output[index] = await work(values[index]!, index);
            }
        })
    );
    return output;
}
