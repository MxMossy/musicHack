<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import PeerModal from '$lib/PeerModal.svelte';

	let { children } = $props();
	let peerModalOpen = $state(false);
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
<button
	onclick={() => (peerModalOpen = true)}
	class="fixed top-4 right-4 z-20 cursor-pointer rounded-none border border-zinc-700 px-3 py-1.5 font-mono text-[10px] tracking-widest text-zinc-500 uppercase transition-colors hover:border-zinc-500 hover:text-zinc-300"
>
	Peer
</button>
{@render children()}
<PeerModal bind:open={peerModalOpen} />
