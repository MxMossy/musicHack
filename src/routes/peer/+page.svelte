<script lang="ts">
	import { page } from '$app/state';
	import { onMount, onDestroy } from 'svelte';
	import Peer, { type DataConnection } from 'peerjs';
	import { getIceServers } from '$lib/iceServers';

	const joinCode = page.url.searchParams.get('joincode') ?? '';
	let status = $state<'connecting' | 'connected' | 'error'>('connecting');
	let needsPermission = $state(false);
	let orientation = $state<{ alpha: number | null; beta: number | null; gamma: number | null } | null>(null);
	let boidHue = $state<number | null>(null);
	let peer: Peer | null = null;
	let conn: DataConnection | null = null;
	let lastSend = 0;
	let motionEnabled = $state(false);
	let wakeLockSupported = $state(false);
	let wakeLockActive = $state(false);
	let wakeLockError = $state('');
	let reconnecting = false;
	let wakeLock: WakeLockSentinel | null = null;
	let presenceIntervalId: ReturnType<typeof setInterval> | null = null;

	type WakeLockSentinel = {
		released: boolean;
		release: () => Promise<void>;
		addEventListener?: (type: 'release', listener: () => void) => void;
	};

	type WakeLockNavigator = Navigator & {
		wakeLock?: {
			request: (type: 'screen') => Promise<WakeLockSentinel>;
		};
	};

	function shouldMaintainWakeLock({
		isSupported,
		isPageVisible,
		isConnected,
		hasMotionAccess
	}: {
		isSupported: boolean;
		isPageVisible: boolean;
		isConnected: boolean;
		hasMotionAccess: boolean;
	}) {
		return Boolean(isSupported && isPageVisible && isConnected && hasMotionAccess);
	}

	function getWakeLockMessage({
		isSupported,
		isActive,
		errorMessage
	}: {
		isSupported: boolean;
		isActive: boolean;
		errorMessage: string;
	}) {
		if (!isSupported) return 'Wake lock unavailable on this browser';
		if (isActive) return 'Screen will stay awake while tracking';
		if (errorMessage) return errorMessage;
		return 'Tap Enable Motion and keep this page open';
	}

	function startGyro() {
		if (motionEnabled) return;
		motionEnabled = true;
		window.addEventListener('deviceorientation', handleOrientation);
	}

	function stopGyro() {
		if (!motionEnabled) return;
		motionEnabled = false;
		window.removeEventListener('deviceorientation', handleOrientation);
	}

	function handleOrientation(e: DeviceOrientationEvent) {
		orientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
		if (!conn) return;
		const now = performance.now();
		if (now - lastSend < 50) return; // ~20fps
		lastSend = now;
		conn.send({ type: 'orientation', alpha: e.alpha, beta: e.beta, gamma: e.gamma });
	}

	function sendPresence() {
		if (!conn?.open) return;
		conn.send({ type: 'peer-presence' });
	}

	function startPresenceHeartbeat() {
		stopPresenceHeartbeat();
		sendPresence();
		presenceIntervalId = setInterval(sendPresence, 1000);
	}

	function stopPresenceHeartbeat() {
		if (presenceIntervalId == null) return;
		clearInterval(presenceIntervalId);
		presenceIntervalId = null;
	}

	async function requestWakeLock() {
		const wakeLockApi = (navigator as WakeLockNavigator).wakeLock;
		if (!shouldMaintainWakeLock({
			isSupported: Boolean(wakeLockApi),
			isPageVisible: document.visibilityState === 'visible',
			isConnected: status === 'connected',
			hasMotionAccess: motionEnabled
		})) {
			return;
		}

		try {
			wakeLockError = '';
			wakeLock = await wakeLockApi!.request('screen');
			wakeLockActive = !wakeLock.released;
			wakeLock.addEventListener?.('release', () => {
				wakeLockActive = false;
			});
		} catch {
			wakeLockActive = false;
			wakeLockError = 'Unable to keep the screen awake on this device';
		}
	}

	async function releaseWakeLock() {
		if (!wakeLock) return;
		const activeWakeLock = wakeLock;
		wakeLock = null;
		wakeLockActive = false;
		try {
			if (!activeWakeLock.released) await activeWakeLock.release();
		} catch {
			// Ignore release errors while the page is being backgrounded or closed.
		}
	}

	async function syncWakeLock() {
		wakeLockSupported = 'wakeLock' in navigator;
		if (!shouldMaintainWakeLock({
			isSupported: wakeLockSupported,
			isPageVisible: document.visibilityState === 'visible',
			isConnected: status === 'connected',
			hasMotionAccess: motionEnabled
		})) {
			await releaseWakeLock();
			return;
		}

		if (wakeLockActive && wakeLock && !wakeLock.released) return;
		await releaseWakeLock();
		await requestWakeLock();
	}

	async function requestPermission() {
		// iOS 13+ requires explicit permission
		const DOE = DeviceOrientationEvent as unknown as {
			requestPermission?: () => Promise<'granted' | 'denied'>;
		};
		if (typeof DOE.requestPermission === 'function') {
			const result = await DOE.requestPermission();
			if (result === 'granted') {
				startGyro();
				await syncWakeLock();
			}
		} else {
			startGyro();
			await syncWakeLock();
		}
		needsPermission = false;
	}

	function attachConnection(connection: DataConnection) {
		conn = connection;
		conn.on('open', async () => {
			status = 'connected';
			reconnecting = false;
			startPresenceHeartbeat();
			// Check if we need explicit iOS permission
			const DOE = DeviceOrientationEvent as unknown as { requestPermission?: unknown };
			if (typeof DOE.requestPermission === 'function') {
				needsPermission = !motionEnabled;
			} else if (!motionEnabled) {
				startGyro();
			}
			await syncWakeLock();
		});
		conn.on('data', (raw) => {
			if (
				raw != null &&
				typeof raw === 'object' &&
				'type' in raw &&
				raw.type === 'peer-visual-state'
			) {
				const message = raw as { type: 'peer-visual-state'; boidHue: number | null };
				boidHue = typeof message.boidHue === 'number' ? message.boidHue : null;
			}
		});
		conn.on('close', () => {
			conn = null;
			boidHue = null;
			stopPresenceHeartbeat();
			status = 'connecting';
			void syncWakeLock();
		});
		conn.on('error', () => {
			boidHue = null;
			stopPresenceHeartbeat();
			status = 'error';
			void syncWakeLock();
		});
	}

	async function connect() {
		const iceServers = await getIceServers();
		peer?.destroy();
		peer = new Peer(iceServers.length ? { config: { iceServers } } : {});
		peer.on('open', () => {
			status = 'connecting';
			attachConnection(peer!.connect(joinCode));
		});
		peer.on('disconnected', () => {
			status = 'connecting';
			void syncWakeLock();
		});
		peer.on('close', () => {
			status = 'connecting';
			void syncWakeLock();
		});
		peer.on('error', () => {
			status = 'error';
			void syncWakeLock();
		});
	}

	async function resumePhoneSession() {
		if (document.visibilityState !== 'visible') {
			await syncWakeLock();
			return;
		}

		await syncWakeLock();
		if (status === 'connected' || reconnecting || !joinCode) return;
		reconnecting = true;
		status = 'connecting';
		try {
			await connect();
		} finally {
			reconnecting = false;
		}
	}

	onMount(() => {
		if (!joinCode) { status = 'error'; return; }
		wakeLockSupported = 'wakeLock' in navigator;
		void connect();
		document.addEventListener('visibilitychange', resumePhoneSession);
	});

	onDestroy(() => {
		document.removeEventListener('visibilitychange', resumePhoneSession);
		stopGyro();
		stopPresenceHeartbeat();
		void releaseWakeLock();
		conn?.close();
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
		{#if boidHue != null}
			<div class="mt-1 flex items-center gap-2">
				<div
					class="h-2.5 w-2.5 rounded-full shadow-[0_0_12px_rgba(255,255,255,0.18)]"
					style={`background-color: hsl(${boidHue} 96% 64%)`}
				></div>
				<p class="font-mono text-[10px] tracking-widest text-zinc-400 uppercase">
					Your boid
				</p>
			</div>
		{/if}
		{#if needsPermission}
			<button
				onclick={requestPermission}
				class="mt-2 cursor-pointer rounded-none border border-zinc-700 px-4 py-2 font-mono text-[10px] tracking-widest text-zinc-300 uppercase hover:bg-zinc-900"
			>
				Enable Motion
			</button>
		{/if}
		<p
			class={`mt-2 text-center font-mono text-[10px] tracking-widest uppercase ${
				wakeLockActive ? 'text-cyan-300' : 'text-zinc-500'
			}`}
		>
			{getWakeLockMessage({
				isSupported: wakeLockSupported,
				isActive: wakeLockActive,
				errorMessage: wakeLockError
			})}
		</p>
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
