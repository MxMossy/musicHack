<script lang="ts">
	import { onDestroy } from 'svelte';
	import QRCode from 'qrcode';
	import Peer from 'peerjs';
	import { peerStore, type Orientation } from './peerStore.svelte.ts';
	import { getIceServers } from './iceServers.ts';

	let { open = $bindable(false) } = $props();

	function generateCode(): string {
		return Array.from({ length: 4 }, () =>
			'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]
		).join('');
	}

	const BACKEND_URL = 'ws://localhost:8765';

	const joinCode = generateCode();
	let qrDataUrl = $state('');
	let connectedPeers = $state(0);
	let peer: Peer | null = null;
	let ws: WebSocket | null = null;

	function fmt(n: number | null): string {
		return n == null ? '--' : n.toFixed(1).padStart(7);
	}

	async function setup() {
		const url = `${window.location.origin}/peer?joincode=${joinCode}`;
		qrDataUrl = await QRCode.toDataURL(url, {
			width: 192,
			margin: 2,
			color: { dark: '#ffffff', light: '#09090b' }
		});

		ws = new WebSocket(BACKEND_URL);

		const iceServers = await getIceServers();
		peer = new Peer(joinCode, iceServers.length ? { config: { iceServers } } : {});
		peer.on('connection', (conn) => {
			connectedPeers++;
			conn.on('data', (raw) => {
				const data = raw as Orientation;
				peerStore.update(conn.peer, data);
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ peerId: conn.peer, ...data }));
				}
			});
			conn.on('close', () => {
				connectedPeers = Math.max(0, connectedPeers - 1);
				peerStore.remove(conn.peer);
			});
		});
	}

	function teardown() {
		ws?.close();
		ws = null;
		peer?.destroy();
		peer = null;
		connectedPeers = 0;
		qrDataUrl = '';
		peerStore.clear();
	}

	$effect(() => {
		if (open) setup();
		else teardown();
	});

	onDestroy(teardown);

	const orientationEntries = $derived(Object.entries(peerStore.orientations));
</script>

{#if open}
	<!-- backdrop -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/75"
		onclick={() => (open = false)}
		role="dialog"
		aria-modal="true"
	>
		<!-- modal -->
		<div
			class="relative flex flex-col items-center gap-5 border border-zinc-800 bg-zinc-950 px-12 py-10"
			onclick={(e) => e.stopPropagation()}
		>
			<!-- close -->
			<button
				onclick={() => (open = false)}
				class="absolute right-3 top-3 cursor-pointer font-mono text-[10px] text-zinc-600 hover:text-zinc-300"
			>
				✕
			</button>

			<!-- join code -->
			<p class="font-mono text-4xl tracking-[0.5em] text-white">{joinCode}</p>

			<!-- qr code -->
			{#if qrDataUrl}
				<img src={qrDataUrl} alt="Scan to join" width="192" height="192" />
			{:else}
				<div class="h-48 w-48 animate-pulse bg-zinc-900"></div>
			{/if}

			<!-- peer count -->
			<p class="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">
				{connectedPeers} {connectedPeers === 1 ? 'peer' : 'peers'} connected
			</p>

			<!-- orientation data -->
			{#if orientationEntries.length > 0}
				<div class="w-full border-t border-zinc-800 pt-4 flex flex-col gap-3">
					{#each orientationEntries as [id, o], i}
						<div>
							{#if orientationEntries.length > 1}
								<p class="font-mono text-[9px] tracking-widest text-zinc-600 uppercase mb-1">
									Peer {i + 1}
								</p>
							{/if}
							<div class="grid grid-cols-3 gap-4 text-center">
								<div>
									<p class="font-mono text-[9px] text-zinc-600 uppercase tracking-widest">α</p>
									<p class="font-mono text-sm tabular-nums text-zinc-300">{fmt(o.alpha)}°</p>
								</div>
								<div>
									<p class="font-mono text-[9px] text-zinc-600 uppercase tracking-widest">β</p>
									<p class="font-mono text-sm tabular-nums text-zinc-300">{fmt(o.beta)}°</p>
								</div>
								<div>
									<p class="font-mono text-[9px] text-zinc-600 uppercase tracking-widest">γ</p>
									<p class="font-mono text-sm tabular-nums text-zinc-300">{fmt(o.gamma)}°</p>
								</div>
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}
