<script lang="ts">
	import { onMount } from 'svelte';
	import BoidsWorker from './boids.worker?worker';

	let { class: klass = 'fixed inset-0 bg-[#0a0a0f]' }: { class?: string } = $props();

	let canvasEl = $state<HTMLCanvasElement | undefined>();

	export function setClientExcitement(clientId: string, value: number) {
		worker?.postMessage({ type: 'setClientExcitement', clientId, value });
	}

	export function setBoidExcitement(boidId: string, value: number) {
		worker?.postMessage({ type: 'setBoidExcitement', boidId, value });
	}

	let worker: Worker | null = null;

	onMount(() => {
		worker = new BoidsWorker();

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
		};
	});
</script>

<div class={klass}>
	<canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
</div>
