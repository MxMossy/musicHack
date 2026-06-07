<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import BoidsWorker from './boids.worker?worker';
	import { peerStore } from './peerStore.svelte.ts';

	let { class: klass = 'fixed inset-0 bg-[#0a0a0f]' }: { class?: string } = $props();

	let canvasEl = $state<HTMLCanvasElement | undefined>();

	export function setClientExcitement(clientId: string, value: number) {
		worker?.postMessage({ type: 'setClientExcitement', clientId, value });
	}

	export function setBoidExcitement(boidId: string, value: number) {
		worker?.postMessage({ type: 'setBoidExcitement', boidId, value });
	}

	let worker: Worker | null = null;
	let forwardedPeerIds = new Set<string>();

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
		};
	});

	$effect(() => {
		const currentPeerIds = new Set(Object.keys(peerStore.peers));

		for (const peerId of forwardedPeerIds) {
			if (!currentPeerIds.has(peerId)) {
				setClientExcitement(peerId, 0);
				forwardedPeerIds.delete(peerId);
			}
		}

		for (const [peerId, peerState] of Object.entries(peerStore.peers)) {
			setClientExcitement(peerId, peerState.energy);
			forwardedPeerIds.add(peerId);
		}
	});

	onDestroy(() => {
		for (const peerId of forwardedPeerIds) {
			setClientExcitement(peerId, 0);
		}
		forwardedPeerIds.clear();
	});
</script>

<div class={klass}>
	<canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
</div>
