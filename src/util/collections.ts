/** Removes the oldest entry of a `Set` or `Map`, which is the first one added. Does nothing when it is empty. */
export function dropOldest<K>(collection: { keys(): IterableIterator<K>; delete(key: K): boolean }): void {
	const oldest = collection.keys().next();
	if (!oldest.done) {
		collection.delete(oldest.value);
	}
}
