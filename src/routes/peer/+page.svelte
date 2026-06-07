<script lang="ts">
	import { page } from '$app/state';
	import { onMount, onDestroy } from 'svelte';
	import Peer, { type DataConnection } from 'peerjs';
	import { getIceServers } from '$lib/iceServers';

	const joinCode = page.url.searchParams.get('joincode') ?? '';
	let status = $state<'connecting' | 'connected' | 'error'>('connecting');
	let needsPermission = $state(false);
	let orientation = $state<{ alpha: number | null; beta: number | null; gamma: number | null } | null>(null);
	let peer: Peer;
	let conn: DataConnection | null = null;
	let lastSend = 0;

	function startGyro() {
		window.addEventListener('deviceorientation', handleOrientation);
	}

	function handleOrientation(e: DeviceOrientationEvent) {
		orientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
		if (!conn) return;
		const now = performance.now();
		if (now - lastSend < 50) return; // ~20fps
		lastSend = now;
		conn.send({ alpha: e.alpha, beta: e.beta, gamma: e.gamma });
	}

	async function requestPermission() {
		// iOS 13+ requires explicit permission
		const DOE = DeviceOrientationEvent as unknown as {
			requestPermission?: () => Promise<'granted' | 'denied'>;
		};
		if (typeof DOE.requestPermission === 'function') {
			const result = await DOE.requestPermission();
			if (result === 'granted') startGyro();
		} else {
			startGyro();
		}
		needsPermission = false;
	}

	async function connect() {
		const iceServers = await getIceServers();
		peer = new Peer(iceServers.length ? { config: { iceServers } } : {});
		peer.on('open', () => {
			conn = peer.connect(joinCode);
			conn.on('open', () => {
				status = 'connected';
				// Check if we need explicit iOS permission
				const DOE = DeviceOrientationEvent as unknown as { requestPermission?: unknown };
				if (typeof DOE.requestPermission === 'function') {
					needsPermission = true;
				} else {
					startGyro();
				}
			});
			conn.on('error', () => (status = 'error'));
		});
		peer.on('error', () => (status = 'error'));
	}

	onMount(() => {
		if (!joinCode) { status = 'error'; return; }
		connect();
	});

	onDestroy(() => {
		window.removeEventListener('deviceorientation', handleOrientation);
		peer?.destroy();
	});
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950">
	<p class="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">Joining</p>
	<p class="font-mono text-4xl tracking-[0.5em] text-white">{joinCode || '????'}</p>

	{#if status === 'connecting'}
		<p class="animate-pulse font-mono text-[10px] tracking-widest text-zinc-600 uppercase">
			Connecting...
		</p>
	{:else if status === 'connected'}
		<p class="font-mono text-[10px] tracking-widest text-green-500 uppercase">Connected</p>
		{#if needsPermission}
			<button
				onclick={requestPermission}
				class="mt-2 cursor-pointer rounded-none border border-zinc-700 px-4 py-2 font-mono text-[10px] tracking-widest text-zinc-300 uppercase hover:bg-zinc-900"
			>
				Enable Motion
			</button>
		{/if}
		{#if orientation}
			<div class="mt-4 grid grid-cols-3 gap-6 text-center">
				<div>
					<p class="font-mono text-[9px] tracking-widest text-zinc-600 uppercase">α</p>
					<p class="font-mono text-lg tabular-nums text-zinc-300">{orientation.alpha?.toFixed(1) ?? '--'}°</p>
				</div>
				<div>
					<p class="font-mono text-[9px] tracking-widest text-zinc-600 uppercase">β</p>
					<p class="font-mono text-lg tabular-nums text-zinc-300">{orientation.beta?.toFixed(1) ?? '--'}°</p>
				</div>
				<div>
					<p class="font-mono text-[9px] tracking-widest text-zinc-600 uppercase">γ</p>
					<p class="font-mono text-lg tabular-nums text-zinc-300">{orientation.gamma?.toFixed(1) ?? '--'}°</p>
				</div>
			</div>
		{:else}
			<p class="font-mono text-[10px] text-zinc-700 mt-4">No motion data</p>
		{/if}
	{:else}
		<p class="font-mono text-[10px] tracking-widest text-red-500 uppercase">Connection failed</p>
	{/if}
</div>
