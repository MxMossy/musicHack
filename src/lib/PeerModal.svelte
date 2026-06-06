<script lang="ts">
	import { onDestroy } from 'svelte';
	import QRCode from 'qrcode';
	import Peer from 'peerjs';

	let { open = $bindable(false) } = $props();

	function generateCode(): string {
		return Array.from({ length: 4 }, () =>
			'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[Math.floor(Math.random() * 26)]
		).join('');
	}

	const joinCode = generateCode();
	let qrDataUrl = $state('');
	let connectedPeers = $state(0);
	let peer: Peer | null = null;

	async function setup() {
		const url = `${window.location.origin}/peer?joincode=${joinCode}`;
		qrDataUrl = await QRCode.toDataURL(url, {
			width: 192,
			margin: 2,
			color: { dark: '#ffffff', light: '#09090b' }
		});

		peer = new Peer(joinCode);
		peer.on('connection', (conn) => {
			connectedPeers++;
			conn.on('close', () => { connectedPeers = Math.max(0, connectedPeers - 1); });
		});
	}

	function teardown() {
		peer?.destroy();
		peer = null;
		connectedPeers = 0;
		qrDataUrl = '';
	}

	$effect(() => {
		if (open) setup();
		else teardown();
	});

	onDestroy(teardown);
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
		</div>
	</div>
{/if}
