export type Orientation = {
	alpha: number | null;
	beta: number | null;
	gamma: number | null;
};

export type PeerMotionState = {
	orientation: Orientation;
	previousOrientation: Orientation | null;
	lastUpdatedAt: number;
	rawEnergy: number;
	energy: number;
	sampleCount: number;
	boidHue: number | null;
};

const ENERGY_SMOOTHING = 0.2;
const ENERGY_DEGREES_PER_SECOND_MAX = 360;

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function angularDifference(next: number | null, prev: number | null): number {
	if (next == null || prev == null) return 0;
	const delta = ((next - prev + 540) % 360) - 180;
	return Math.abs(delta);
}

function computeRawEnergy(next: Orientation, prev: Orientation, elapsedMs: number): number {
	const alphaDelta = angularDifference(next.alpha, prev.alpha);
	const betaDelta = angularDifference(next.beta, prev.beta);
	const gammaDelta = angularDifference(next.gamma, prev.gamma);
	const totalDelta = alphaDelta + betaDelta + gammaDelta;
	const degreesPerSecond = totalDelta / Math.max(elapsedMs, 16) * 1000;
	return clamp01(degreesPerSecond / ENERGY_DEGREES_PER_SECOND_MAX);
}

class PeerStore {
	peers = $state<Record<string, PeerMotionState>>({});
	orientations = $state<Record<string, Orientation>>({});

	ensurePeer(peerId: string) {
		const existing = this.peers[peerId];
		if (existing) return;

		this.peers[peerId] = {
			orientation: { alpha: null, beta: null, gamma: null },
			previousOrientation: null,
			lastUpdatedAt: performance.now(),
			rawEnergy: 0,
			energy: 0,
			sampleCount: 0,
			boidHue: null
		};
	}

	touch(peerId: string) {
		this.ensurePeer(peerId);
		this.peers[peerId] = {
			...this.peers[peerId],
			lastUpdatedAt: performance.now()
		};
	}

	update(peerId: string, data: Orientation) {
		const now = performance.now();
		const existing = this.peers[peerId];
		const rawEnergy =
			existing == null
				? 0
				: computeRawEnergy(data, existing.orientation, now - existing.lastUpdatedAt);
		const energy =
			existing == null
				? 0
				: existing.energy + (rawEnergy - existing.energy) * ENERGY_SMOOTHING;

		this.peers[peerId] = {
			orientation: data,
			previousOrientation: existing?.orientation ?? null,
			lastUpdatedAt: now,
			rawEnergy,
			energy,
			sampleCount: (existing?.sampleCount ?? 0) + 1,
			boidHue: existing?.boidHue ?? null
		};
		this.orientations[peerId] = data;
	}

	setBoidHue(peerId: string, boidHue: number | null) {
		this.ensurePeer(peerId);
		this.peers[peerId] = {
			...this.peers[peerId],
			boidHue
		};
	}

	remove(peerId: string) {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete this.peers[peerId];
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
		delete this.orientations[peerId];
	}

	clear() {
		this.peers = {};
		this.orientations = {};
	}
}

export const peerStore = new PeerStore();
