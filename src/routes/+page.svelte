<script lang="ts">
	import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

	const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
	const POSE_MODEL =
		'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
	const HAND_MODEL =
		'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

	const LANDMARK_NAMES = [
		'WRIST',
		'THUMB_CMC', 'THUMB_MCP', 'THUMB_IP', 'THUMB_TIP',
		'INDEX_MCP', 'INDEX_PIP', 'INDEX_DIP', 'INDEX_TIP',
		'MIDDLE_MCP', 'MIDDLE_PIP', 'MIDDLE_DIP', 'MIDDLE_TIP',
		'RING_MCP', 'RING_PIP', 'RING_DIP', 'RING_TIP',
		'PINKY_MCP', 'PINKY_PIP', 'PINKY_DIP', 'PINKY_TIP',
	];
	const LEFT_HAND_ENERGY_LANDMARKS = LANDMARK_NAMES.map((_, i) => i);
	// fingertips only: [4, 8, 12, 16, 20]
	// wrist + fingertips: [0, 4, 8, 12, 16, 20]

	let stream = $state<MediaStream | null>(null);
	let error = $state('');
	let status = $state('');
	let videoEl: HTMLVideoElement | undefined = $state();
	let canvasEl: HTMLCanvasElement | undefined = $state();
	let poseLandmarker: PoseLandmarker | undefined;
	let handLandmarker: HandLandmarker | undefined;
	let rafId: number;

	type Landmark = { x: number; y: number; z: number };
	type PreviousPoint = { x: number; y: number; t: number };
	let handData = $state<Landmark[][]>([]);
	let lastDataUpdate = 0;

	// pose detection state (used for slider + note gate logic)
	let leftHandY = $state(0.5);
	let leftHandActive = $state(false);
	let leftHandEnergy = $state(0);
	let rightHandY = $state(0.5);
	let rightHandActive = $state(false);
	let previousLeftHandPoints = new Map<number, PreviousPoint>();

	let rightArmRaised = $state(false);
	let prevRightArmRaised = false;
	let leftArmRaised = $state(false);
	let prevLeftArmRaised = false;

	// MIDI device
	let midiOutputs = $state<MIDIOutput[]>([]);
	let midiOutput = $state<MIDIOutput | null>(null);
	let midiChannel = $state(10);
	let lastMidiSend = 0;

	// MIDI mappings — each entry owns its type, target number, and live value
	type CcMapping   = { name: string; type: 'cc';   number: number; value: number };
	type NoteMapping = { name: string; type: 'note'; number: number; value: boolean };
	type MidiMapping = CcMapping | NoteMapping;

	let midiMappings = $state<MidiMapping[]>([
		{ name: 'Left Hand Y',  type: 'cc',   number: 1,  value: 0     },
		{ name: 'Right Hand Y', type: 'cc',   number: 2,  value: 0     },
		{ name: 'Left Arm',     type: 'note', number: 61, value: false },
		{ name: 'Right Arm',    type: 'note', number: 60, value: false },
		{ name: 'Left Hand Energy', type: 'cc', number: 3, value: 0 },
	]);

	async function initMidi() {
		try {
			const access = await navigator.requestMIDIAccess();
			const refresh = () => {
				midiOutputs = [...access.outputs.values()];
				if (!midiOutput && midiOutputs.length > 0) midiOutput = midiOutputs[0];
			};
			refresh();
			access.onstatechange = refresh;
		} catch {
			// MIDI unavailable or denied — fail silently
		}
	}

	function sendCC(mapping: CcMapping, raw: number) {
		if (!midiOutput) return;
		midiOutput.send([
			0xb0 | (midiChannel - 1),
			mapping.number,
			Math.max(0, Math.min(127, Math.round(raw * 127)))
		]);
	}

	function sendNote(mapping: NoteMapping, on: boolean) {
		if (!midiOutput) return;
		midiOutput.send([(on ? 0x90 : 0x80) | (midiChannel - 1), mapping.number, on ? 100 : 0]);
	}

	function clamp01(value: number): number {
		return Math.max(0, Math.min(1, value));
	}

	function computeAverageLandmarkSpeed(
		landmarks: Landmark[],
		previousPoints: Map<number, PreviousPoint>,
		indices: number[],
		now: number
	): number {
		let totalSpeed = 0;
		let count = 0;

		for (const index of indices) {
			const landmark = landmarks[index];
			if (!landmark) continue;

			const previous = previousPoints.get(index);
			if (previous) {
				const dt = (now - previous.t) / 1000;
				if (dt > 0) {
					const distance = Math.hypot(landmark.x - previous.x, landmark.y - previous.y);
					totalSpeed += distance / dt;
					count += 1;
				}
			}

			previousPoints.set(index, { x: landmark.x, y: landmark.y, t: now });
		}

		return count > 0 ? totalSpeed / count : 0;
	}

	function computeLeftHandEnergy(landmarks: Landmark[], now: number): number {
		const speedForMaxEnergy = 2.5;
		const averageSpeed = computeAverageLandmarkSpeed(
			landmarks,
			previousLeftHandPoints,
			LEFT_HAND_ENERGY_LANDMARKS,
			now
		);
		const rawEnergy = clamp01(averageSpeed / speedForMaxEnergy);
		leftHandEnergy = leftHandEnergy * 0.8 + rawEnergy * 0.2;
		return leftHandEnergy;
	}

	async function initDetectors() {
		status = 'Loading models...';
		const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
		[poseLandmarker, handLandmarker] = await Promise.all([
			PoseLandmarker.createFromOptions(vision, {
				baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
				runningMode: 'VIDEO',
				numPoses: 1
			}),
			HandLandmarker.createFromOptions(vision, {
				baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
				runningMode: 'VIDEO',
				numHands: 2
			})
		]);
		status = '';
	}

	async function startCamera() {
		error = '';
		try {
			stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
			if (videoEl) videoEl.srcObject = stream;
			await Promise.all([initDetectors(), initMidi()]);
			runLoop();
		} catch {
			error = 'Camera access denied.';
			stream = null;
			status = '';
		}
	}

	function drawConnections(
		ctx: CanvasRenderingContext2D,
		landmarks: Landmark[],
		connections: readonly { start: number; end: number }[],
		w: number,
		h: number
	) {
		ctx.beginPath();
		for (const { start, end } of connections) {
			const a = landmarks[start];
			const b = landmarks[end];
			ctx.moveTo(a.x * w, a.y * h);
			ctx.lineTo(b.x * w, b.y * h);
		}
		ctx.stroke();
	}

	function depthColor(z: number): string {
		const t = Math.max(0, Math.min(1, (z + 0.3) / 0.6));
		const hue = (1 - t) * 120;
		return `hsl(${hue}, 100%, 55%)`;
	}

	function drawJoints(
		ctx: CanvasRenderingContext2D,
		landmarks: Landmark[],
		radius: number,
		w: number,
		h: number
	) {
		for (const lm of landmarks) {
			ctx.fillStyle = depthColor(lm.z);
			ctx.beginPath();
			ctx.arc(lm.x * w, lm.y * h, radius, 0, Math.PI * 2);
			ctx.fill();
		}
	}

	function runLoop() {
		if (!videoEl || !canvasEl || !poseLandmarker || !handLandmarker || !stream) return;

		if (videoEl.readyState >= 2) {
			const w = videoEl.videoWidth;
			const h = videoEl.videoHeight;
			if (canvasEl.width !== w) canvasEl.width = w;
			if (canvasEl.height !== h) canvasEl.height = h;

			const ctx = canvasEl.getContext('2d')!;
			ctx.clearRect(0, 0, w, h);
			const now = performance.now();

			const pose = poseLandmarker.detectForVideo(videoEl, now);
			ctx.strokeStyle = 'rgba(255,255,255,0.45)';
			ctx.lineWidth = 1.5;
			for (const landmarks of pose.landmarks) {
				drawConnections(ctx, landmarks, PoseLandmarker.POSE_CONNECTIONS, w, h);
				drawJoints(ctx, landmarks, 3, w, h);

				const rRaised = landmarks[16].y < landmarks[12].y;
				rightArmRaised = rRaised;
				midiMappings[3].value = rRaised;
				if (rRaised !== prevRightArmRaised) {
					sendNote(midiMappings[3] as NoteMapping, rRaised);
					prevRightArmRaised = rRaised;
				}

				const lRaised = landmarks[15].y < landmarks[11].y;
				leftArmRaised = lRaised;
				midiMappings[2].value = lRaised;
				if (lRaised !== prevLeftArmRaised) {
					sendNote(midiMappings[2] as NoteMapping, lRaised);
					prevLeftArmRaised = lRaised;
				}
			}

			const hands = handLandmarker.detectForVideo(videoEl, now);
			ctx.strokeStyle = 'rgba(255,255,255,0.75)';
			ctx.lineWidth = 1;
			leftHandActive = false;
			for (let i = 0; i < hands.landmarks.length; i++) {
				const landmarks = hands.landmarks[i];
				drawConnections(ctx, landmarks, HandLandmarker.HAND_CONNECTIONS, w, h);
				drawJoints(ctx, landmarks, 2.5, w, h);
				const handedness = hands.handednesses[i]?.[0]?.categoryName;
				if (handedness === 'Left') {
					leftHandY = landmarks[0].y;
					leftHandActive = true;
					midiMappings[0].value = leftHandY;
					const energy = computeLeftHandEnergy(landmarks, now);
					const leftHandEnergyMapping = midiMappings[4];
					leftHandEnergyMapping.value = energy;
					if (now - lastMidiSend > 33) {
						sendCC(midiMappings[0] as CcMapping, leftHandY);
						sendCC(leftHandEnergyMapping as CcMapping, energy);
					}
				} else if (handedness === 'Right') {
					rightHandY = landmarks[0].y;
					rightHandActive = true;
					midiMappings[1].value = rightHandY;
					if (now - lastMidiSend > 33) {
						sendCC(midiMappings[1] as CcMapping, rightHandY);
					}
				}
				if (now - lastMidiSend > 33) lastMidiSend = now;
			}

			if (!leftHandActive) {
				previousLeftHandPoints.clear();
				leftHandEnergy = leftHandEnergy * 0.9;
				midiMappings[4].value = leftHandEnergy;
			}

			if (now - lastDataUpdate > 100) {
				handData = hands.landmarks as Landmark[][];
				lastDataUpdate = now;
			}
		}

		rafId = requestAnimationFrame(runLoop);
	}

	function stopCamera() {
		cancelAnimationFrame(rafId);
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		status = '';
		handData = [];
		leftHandActive = false;
		rightHandActive = false;
		previousLeftHandPoints.clear();
		leftHandEnergy = 0;
		if (rightArmRaised) sendNote(midiMappings[3] as NoteMapping, false);
		if (leftArmRaised) sendNote(midiMappings[2] as NoteMapping, false);
		rightArmRaised = false;
		prevRightArmRaised = false;
		leftArmRaised = false;
		prevLeftArmRaised = false;
		midiMappings[0].value = 0;
		midiMappings[1].value = 0;
		midiMappings[2].value = false;
		midiMappings[3].value = false;
		midiMappings[4].value = 0;
		if (videoEl) videoEl.srcObject = null;
		if (canvasEl) canvasEl.getContext('2d')?.clearRect(0, 0, canvasEl.width, canvasEl.height);
	}
</script>

<div class="flex h-screen overflow-hidden bg-zinc-950">
	<!-- main area -->
	<div class="flex flex-1 flex-col items-center justify-center gap-6 p-8 min-w-0">
		<div class="flex items-stretch gap-3 w-full max-w-2xl {stream ? '' : 'hidden'}">
			<div class="relative flex-1 aspect-video">
				<video
					bind:this={videoEl}
					autoplay
					playsinline
					muted
					class="h-full w-full border border-zinc-800 object-cover"
				></video>
				<canvas bind:this={canvasEl} class="absolute inset-0 h-full w-full"></canvas>
				{#if status}
					<div class="absolute bottom-2 left-2 z-10 flex items-center gap-1.5">
						<div class="h-1.5 w-1.5 animate-pulse bg-zinc-400"></div>
						<span class="font-mono text-[10px] tracking-widest text-zinc-400 uppercase">{status}</span>
					</div>
				{/if}
			</div>

			<!-- left hand y slider -->
			<div class="relative w-4 border border-zinc-800">
				<div class="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-zinc-800"></div>
				<div
					class="absolute left-0 right-0 h-px {leftHandActive ? 'bg-white' : 'bg-zinc-700'}"
					style="top: {(leftHandY * 100).toFixed(2)}%"
				></div>
			</div>
		</div>

		<button
			onclick={stream ? stopCamera : startCamera}
			class="cursor-pointer rounded-none border border-zinc-600 px-6 py-2 font-mono text-xs tracking-widest text-zinc-200 uppercase transition-colors hover:bg-zinc-800"
		>
			{stream ? 'Stop' : 'Start Camera'}
		</button>

		{#if stream}
			<!-- MIDI device controls -->
			<div class="flex items-center gap-3">
				<span class="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">MIDI Out</span>
				{#if midiOutputs.length > 0}
					<select
						onchange={(e) => {
							const id = (e.target as HTMLSelectElement).value;
							midiOutput = midiOutputs.find((o) => o.id === id) ?? null;
						}}
						class="cursor-pointer rounded-none border border-zinc-700 bg-zinc-950 font-mono text-[10px] text-zinc-300 px-2 py-1"
					>
						{#each midiOutputs as out}
							<option value={out.id} selected={midiOutput?.id === out.id}>{out.name}</option>
						{/each}
					</select>
					<span class="font-mono text-[10px] text-zinc-600">CH</span>
					<input
						type="number"
						bind:value={midiChannel}
						min="1"
						max="16"
						class="w-16 rounded-none border border-zinc-700 bg-zinc-950 font-mono text-[10px] text-zinc-300 px-2 py-1 text-center"
					/>
				{:else}
					<span class="font-mono text-[10px] text-zinc-700">No MIDI outputs</span>
				{/if}
			</div>

			<!-- mappings grid -->
			<div class="w-full max-w-2xl">
				<div class="grid grid-cols-[1fr_auto_auto] gap-x-6 gap-y-1">
					<!-- header -->
					<span class="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">Name</span>
					<span class="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">MIDI</span>
					<span class="font-mono text-[10px] tracking-widest text-zinc-600 uppercase text-right">Value</span>

					<!-- rows -->
					{#each midiMappings as m}
						<span class="font-mono text-[10px] text-zinc-400">{m.name}</span>
						<div class="flex items-center gap-1">
							<span class="font-mono text-[10px] text-zinc-500">{m.type === 'cc' ? 'CC' : 'N'}</span>
							<input
								type="number"
								bind:value={m.number}
								min="0"
								max="127"
								class="w-12 rounded-none border border-zinc-700 bg-zinc-950 font-mono text-[10px] text-zinc-300 px-1 py-0.5 text-center"
							/>
						</div>
						{#if m.type === 'cc'}
							<span class="font-mono text-[10px] tabular-nums text-zinc-300 text-right">
								{(m.value as number).toFixed(3)}
							</span>
						{:else}
							<span class="font-mono text-[10px] text-right {m.value ? 'text-white' : 'text-zinc-600'}">
								{m.value ? 'ON' : 'OFF'}
							</span>
						{/if}
					{/each}
				</div>
			</div>
		{/if}

		{#if error}
			<p class="font-mono text-xs tracking-wide text-red-400">{error}</p>
		{/if}
	</div>

	<!-- side panel -->
	{#if stream}
		<div class="flex w-64 shrink-0 flex-col border-l border-zinc-800">
			<div class="border-b border-zinc-800 px-4 py-3">
				<span class="font-mono text-xs tracking-widest text-zinc-500 uppercase">Hand Points</span>
			</div>

			<div class="flex-1 overflow-y-auto px-4 py-3">
				{#if handData.length === 0}
					<p class="font-mono text-xs text-zinc-700">No hands detected</p>
				{:else}
					{#each handData as hand, hi}
						<div class="mb-5">
							<p class="mb-2 font-mono text-xs tracking-widest text-zinc-500 uppercase">
								Hand {hi + 1}
							</p>
							{#each hand as lm, i}
								<div class="mb-1.5">
									<p class="font-mono text-[10px] text-zinc-600">
										{String(i).padStart(2, '0')} {LANDMARK_NAMES[i]}
									</p>
									<p class="font-mono text-[10px] pl-3 text-zinc-400 tabular-nums">
										x {lm.x.toFixed(3)}
										y {lm.y.toFixed(3)}
										<span style="color: {depthColor(lm.z)}">z {lm.z.toFixed(3)}</span>
									</p>
								</div>
							{/each}
						</div>
					{/each}
				{/if}
			</div>
		</div>
	{/if}
</div>
