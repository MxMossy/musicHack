<script lang="ts">
	import { page } from '$app/state';
	import { onMount, onDestroy } from 'svelte';
	import Peer from 'peerjs';

	const joinCode = page.url.searchParams.get('joincode') ?? '';
	let status = $state<'connecting' | 'connected' | 'error'>('connecting');
	let peer: Peer;

	onMount(() => {
		if (!joinCode) {
			status = 'error';
			return;
		}
		peer = new Peer();
		peer.on('open', () => {
			const conn = peer.connect(joinCode);
			conn.on('open', () => (status = 'connected'));
			conn.on('error', () => (status = 'error'));
		});
		peer.on('error', () => (status = 'error'));
	});

	onDestroy(() => peer?.destroy());
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-4 bg-zinc-950">
	<p class="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">Joining</p>
	<p class="font-mono text-4xl tracking-[0.5em] text-white">{joinCode || '????'}</p>

	{#if status === 'connecting'}
		<p class="animate-pulse font-mono text-[10px] tracking-widest text-zinc-600 uppercase">Connecting...</p>
	{:else if status === 'connected'}
		<p class="font-mono text-[10px] tracking-widest text-green-500 uppercase">Connected</p>
	{:else}
		<p class="font-mono text-[10px] tracking-widest text-red-500 uppercase">Connection failed</p>
	{/if}
</div>
