import type { PeerMotionState } from './peerStore.svelte';

export type NodeData = {
	node_1: number;
	node_2: number;
	node_3: number;
	peer_energies: Record<string, number>;
};

export function processPeerData(peersById: Record<string, PeerMotionState>): NodeData {
	const peerEntries = Object.entries(peersById).filter(
		([, peer]) =>
			peer.orientation.alpha != null &&
			peer.orientation.beta != null &&
			peer.orientation.gamma != null
	);

	if (peerEntries.length === 0) {
		return { node_1: 0, node_2: 0, node_3: 0, peer_energies: {} };
	}

	const sum = peerEntries.reduce(
		(acc, [, peer]) => ({
			node_1: acc.node_1 + (peer.orientation.alpha ?? 0),
			node_2: acc.node_2 + (peer.orientation.beta ?? 0),
			node_3: acc.node_3 + (peer.orientation.gamma ?? 0)
		}),
		{ node_1: 0, node_2: 0, node_3: 0 }
	);

	const peerEnergies = Object.fromEntries(
		peerEntries.map(([peerId, peer]) => [peerId, peer.energy])
	);

	return {
		node_1: sum.node_1 / peerEntries.length,
		node_2: sum.node_2 / peerEntries.length,
		node_3: sum.node_3 / peerEntries.length,
		peer_energies: peerEnergies
	};
}
