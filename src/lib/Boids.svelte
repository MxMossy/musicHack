<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import BoidsWorker from './boids.worker?worker';
	import { peerStore } from './peerStore.svelte.ts';

	let { class: klass = 'fixed inset-0 bg-[#0a0a0f]' }: { class?: string } = $props();

	let canvasEl = $state<HTMLCanvasElement | undefined>();

	export function setClientExcitement(clientId: string, value: number) {
		worker?.postMessage({ type: 'setClientExcitement', clientId, value });
	}

	export function ensureClientAssignment(clientId: string) {
		worker?.postMessage({ type: 'ensureClientAssignment', clientId });
	}

	export function setBoidExcitement(boidId: string, value: number) {
		worker?.postMessage({ type: 'setBoidExcitement', boidId, value });
	}

	export function releaseClient(clientId: string) {
		worker?.postMessage({ type: 'releaseClient', clientId });
	}

	let worker: Worker | null = null;
	let forwardedPeerIds = new Set<string>();
	
	// Performance optimization: Track last sent values to deduplicate updates
	let lastSentExcitement = new Map<string, number>();
	const EXCITEMENT_CHANGE_THRESHOLD = 0.03; // Only update if changed by >3%

	onMount(() => {
		worker = new BoidsWorker();
		worker.onmessage = (event: MessageEvent) => {
			const message = event.data;
			if (message?.type === 'controllerVisualState' && typeof message.clientId === 'string') {
				peerStore.setBoidHue(
					message.clientId,
					typeof message.boidHue === 'number' ? message.boidHue : null
				);
			}
		};

		const offscreen = canvasEl!.transferControlToOffscreen();
		worker.postMessage(
			{ type: 'init', canvas: offscreen, w: window.innerWidth, h: window.innerHeight },
			[offscreen]
		);

		const api = window as Window & {
			setBoidExcitement?: (boidId: string, value: number) => void;
			setClientExcitement?: (clientId: string, value: number) => void;
		};
		api.setBoidExcitement = setBoidExcitement;
		api.setClientExcitement = setClientExcitement;

		const handleResize = () => {
			worker?.postMessage({ type: 'resize', w: window.innerWidth, h: window.innerHeight });
		};
		window.addEventListener('resize', handleResize);

		return () => {
			delete api.setBoidExcitement;
			delete api.setClientExcitement;
			window.removeEventListener('resize', handleResize);
			worker?.postMessage({ type: 'stop' });
			worker?.terminate();
			worker = null;
			forwardedPeerIds.clear();
			lastSentExcitement.clear();
		};
	});

	$effect(() => {
		const currentPeerIds = new Set(Object.keys(peerStore.peers));

		for (const peerId of forwardedPeerIds) {
			if (!currentPeerIds.has(peerId)) {
				releaseClient(peerId);
				forwardedPeerIds.delete(peerId);
				lastSentExcitement.delete(peerId);
			}
		}

		for (const [peerId, peerState] of Object.entries(peerStore.peers)) {
			// Only send ensureClientAssignment if client is new
			if (!forwardedPeerIds.has(peerId)) {
				ensureClientAssignment(peerId);
				forwardedPeerIds.add(peerId);
				lastSentExcitement.set(peerId, peerState.energy);
				setClientExcitement(peerId, peerState.energy);
			} else {
				// Only update excitement if it changed significantly
				const lastExcitement = lastSentExcitement.get(peerId) ?? -1;
				if (Math.abs(peerState.energy - lastExcitement) > EXCITEMENT_CHANGE_THRESHOLD) {
					setClientExcitement(peerId, peerState.energy);
					lastSentExcitement.set(peerId, peerState.energy);
				}
			}
		}
	});

	onDestroy(() => {
		for (const peerId of forwardedPeerIds) {
			releaseClient(peerId);
		}
		forwardedPeerIds.clear();
	});
</script>

<div class={klass}>
	<canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
</div>
