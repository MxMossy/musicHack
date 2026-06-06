export type Orientation = {
	alpha: number | null;
	beta: number | null;
	gamma: number | null;
};

class PeerStore {
	orientations = $state<Record<string, Orientation>>({});

	update(peerId: string, data: Orientation) {
		this.orientations[peerId] = data;
	}

	remove(peerId: string) {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete this.orientations[peerId];
	}

	clear() {
		this.orientations = {};
	}
}

export const peerStore = new PeerStore();
