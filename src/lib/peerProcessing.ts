import type { Orientation } from './peerStore.svelte';

export type NodeData = { node_1: number; node_2: number; node_3: number };

export function processPeerData(orientations: Record<string, Orientation>): NodeData {
	const peers = Object.values(orientations).filter(
		(o) => o.alpha != null && o.beta != null && o.gamma != null
	);

	if (peers.length === 0) return { node_1: 0, node_2: 0, node_3: 0 };

	const sum = peers.reduce(
		(acc, o) => ({
			node_1: acc.node_1 + (o.alpha ?? 0),
			node_2: acc.node_2 + (o.beta ?? 0),
			node_3: acc.node_3 + (o.gamma ?? 0)
		}),
		{ node_1: 0, node_2: 0, node_3: 0 }
	);

	return {
		node_1: sum.node_1 / peers.length,
		node_2: sum.node_2 / peers.length,
		node_3: sum.node_3 / peers.length
	};
}
