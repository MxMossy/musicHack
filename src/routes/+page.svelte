<script lang="ts">
	import {
		FilesetResolver,
		GestureRecognizer,
		HandLandmarker,
		PoseLandmarker
	} from '@mediapipe/tasks-vision';
	import {
		clamp01,
		computeFootPoint,
		computeRelativeFootX,
		computeRelativeFootY,
		computeRelativeHandX,
		computeRelativeHandY,
		type Landmark
	} from '$lib/body-relative';
	import PeerModal from '$lib/PeerModal.svelte';

	const WASM_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
	const POSE_MODEL =
		'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
	const HAND_MODEL =
		'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
	const GESTURE_MODEL =
		'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

	const LEFT_HAND_ENERGY_LANDMARKS = Array.from({ length: 21 }, (_, i) => i);
	const RIGHT_HAND_ENERGY_LANDMARKS = Array.from({ length: 21 }, (_, i) => i);
	const POSE_WRIST_ENERGY_LANDMARKS = [0];
	const LEFT_ANKLE = 27;
	const RIGHT_ANKLE = 28;
	const LEFT_HEEL = 29;
	const RIGHT_HEEL = 30;
	const LEFT_FOOT_INDEX = 31;
	const RIGHT_FOOT_INDEX = 32;
	// fingertips only: [4, 8, 12, 16, 20]
	// wrist + fingertips: [0, 4, 8, 12, 16, 20]

	let peerModalOpen = $state(false);
	let stream = $state<MediaStream | null>(null);
	let error = $state('');
	let status = $state('');
	let videoEl: HTMLVideoElement | undefined = $state();
	let canvasEl: HTMLCanvasElement | undefined = $state();
	let videoFileUrl = $state<string | null>(null);
	let hasVideoSource = $state(false);
	let videoMode = $state<'camera' | 'upload' | null>(null);
	let poseLandmarker: PoseLandmarker | undefined;
	let handLandmarker: HandLandmarker | undefined;
	let gestureRecognizer: GestureRecognizer | undefined;
	let rafId: number;

	type PreviousPoint = { x: number; y: number; t: number };
	type HandGestureName = 'Open_Palm' | 'Closed_Fist' | 'None';
	// pose detection state (used for slider + note gate logic)
	let leftHandY = $state(0.5);
	let leftHandActive = $state(false);
	let leftHandEnergy = $state(0);
	let handEnergySensitivity = $state(0.5);
	let rightHandY = $state(0.5);
	let rightHandActive = $state(false);
	let rightHandEnergy = $state(0);
	let previousLeftHandPoints = new Map<number, PreviousPoint>();
	let previousRightHandPoints = new Map<number, PreviousPoint>();
	let previousLeftPoseWristPoints = new Map<number, PreviousPoint>();
	let previousRightPoseWristPoints = new Map<number, PreviousPoint>();
	let previousLeftGesture: HandGestureName = 'None';
	let previousRightGesture: HandGestureName = 'None';

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
	type ThresholdTriggerState = {
		armed: boolean;
		lastTriggerTime: number;
	};

	let midiMappings = $state<MidiMapping[]>([
		{ name: 'Left Hand X', type: 'cc', number: 1, value: 0 },
		{ name: 'Left Hand Y',  type: 'cc',   number: 2,  value: 0 },
		{ name: 'Right Hand X', type: 'cc', number: 3, value: 0 },
		{ name: 'Right Hand Y', type: 'cc',   number: 4,  value: 0 },
		{ name: 'Left Foot X', type: 'cc', number: 5, value: 0 },
		{ name: 'Left Foot Y', type: 'cc', number: 6, value: 0 },
		{ name: 'Right Foot X', type: 'cc', number: 7, value: 0 },
		{ name: 'Right Foot Y', type: 'cc', number: 8, value: 0 },
		{ name: 'Left Hand Energy', type: 'cc', number: 9, value: 0 },
		{ name: 'Right Hand Energy', type: 'cc', number: 10, value: 0 },
		{ name: 'Left Hand Openness', type: 'cc', number: 11, value: 0 },
		{ name: 'Right Hand Openness', type: 'cc', number: 12, value: 0 },
		{ name: 'Left Arm', type: 'note', number: 61, value: false },
		{ name: 'Right Arm', type: 'note', number: 60, value: false },
		{ name: 'Left Energy Burst', type: 'note', number: 62, value: false },
		{ name: 'Right Energy Burst', type: 'note', number: 63, value: false },
		{ name: 'Left Open Hand', type: 'note', number: 64, value: false },
		{ name: 'Left Closed Hand', type: 'note', number: 65, value: false },
		{ name: 'Right Open Hand', type: 'note', number: 66, value: false },
		{ name: 'Right Closed Hand', type: 'note', number: 67, value: false },
		{ name: 'Left Hand Rotation', type: 'cc', number: 13, value: 0.5 },
		{ name: 'Right Hand Rotation', type: 'cc', number: 14, value: 0.5 },
	]);
	let leftEnergyBurstState: ThresholdTriggerState = { armed: true, lastTriggerTime: 0 };
	let rightEnergyBurstState: ThresholdTriggerState = { armed: true, lastTriggerTime: 0 };

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

	function findNoteMapping(name: string): NoteMapping | undefined {
		const mapping = midiMappings.find((entry) => entry.name === name);
		return mapping?.type === 'note' ? mapping : undefined;
	}

	function findCcMapping(name: string): CcMapping | undefined {
		const mapping = midiMappings.find((entry) => entry.name === name);
		return mapping?.type === 'cc' ? mapping : undefined;
	}

	function setCcValue(name: string, value: number, shouldSend = false) {
		const mapping = findCcMapping(name);
		if (!mapping) return;
		mapping.value = value;
		if (shouldSend) sendCC(mapping, value);
	}

	function setNoteValue(name: string, value: boolean, shouldSend = false) {
		const mapping = findNoteMapping(name);
		if (!mapping) return;
		mapping.value = value;
		if (shouldSend) sendNote(mapping, value);
	}

	function resetMidiMappingValues() {
		for (const mapping of midiMappings) {
			if (mapping.type === 'cc') {
				mapping.value = 0;
			} else {
				mapping.value = false;
			}
		}
	}

	function pulseNote(mapping: NoteMapping, durationMs = 100) {
		mapping.value = true;
		sendNote(mapping, true);
		window.setTimeout(() => {
			mapping.value = false;
			sendNote(mapping, false);
		}, durationMs);
	}

	function updateThresholdNoteTrigger(
		value: number,
		state: ThresholdTriggerState,
		mapping: NoteMapping | undefined,
		now: number,
		threshold = 0.7,
		resetThreshold = 0.35,
		cooldownMs = 450
	) {
		if (!mapping) return;

		if (value <= resetThreshold) {
			state.armed = true;
			return;
		}

		if (!state.armed || value < threshold) return;
		if (now - state.lastTriggerTime < cooldownMs) return;

		pulseNote(mapping);
		state.armed = false;
		state.lastTriggerTime = now;
	}

	function handleGestureTrigger(
		side: 'Left' | 'Right',
		gesture: HandGestureName,
		previousGesture: HandGestureName
	): HandGestureName {
		if (gesture === previousGesture) return previousGesture;

		if (gesture === 'Open_Palm') {
			const mapping = findNoteMapping(`${side} Open Hand`);
			if (mapping) pulseNote(mapping);
		}

		if (gesture === 'Closed_Fist') {
			const mapping = findNoteMapping(`${side} Closed Hand`);
			if (mapping) pulseNote(mapping);
		}

		return gesture;
	}

	function isLandmarkOnScreen(landmark: Landmark | undefined, margin = 0): boolean {
		if (!landmark) return false;
		return (
			landmark.x >= -margin &&
			landmark.x <= 1 + margin &&
			landmark.y >= -margin &&
			landmark.y <= 1 + margin
		);
	}

	function isHandOnScreen(landmarks: Landmark[], margin = 0.08): boolean {
		const wrist = landmarks[0];
		return isLandmarkOnScreen(wrist, margin);
	}

	function computeHandScale(landmarks: Landmark[]): number {
		let minX = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const landmark of landmarks) {
			if (!landmark) continue;
			minX = Math.min(minX, landmark.x);
			maxX = Math.max(maxX, landmark.x);
			minY = Math.min(minY, landmark.y);
			maxY = Math.max(maxY, landmark.y);
		}

		if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
			return 0.06;
		}

		const width = maxX - minX;
		const height = maxY - minY;
		const bboxDiagonal = Math.hypot(width, height);
		return Math.max(0.06, bboxDiagonal);
	}

	function computeHandOpenness(landmarks: Landmark[]): number {
		const wrist = landmarks[0];
		if (!wrist) return 0;

		const fingerPairs = [
			{ mcp: 5, tip: 8 },
			{ mcp: 9, tip: 12 },
			{ mcp: 13, tip: 16 },
			{ mcp: 17, tip: 20 }
		] as const;
		const closedRatio = 1.15;
		const openRatio = 1.75;
		let total = 0;
		let count = 0;

		for (const { mcp, tip } of fingerPairs) {
			const base = landmarks[mcp];
			const fingertip = landmarks[tip];
			if (!base || !fingertip) continue;

			const wristToBase = Math.hypot(base.x - wrist.x, base.y - wrist.y, (base.z ?? 0) - (wrist.z ?? 0));
			if (wristToBase <= 0) continue;

			const wristToTip = Math.hypot(
				fingertip.x - wrist.x,
				fingertip.y - wrist.y,
				(fingertip.z ?? 0) - (wrist.z ?? 0)
			);
			const ratio = wristToTip / wristToBase;
			total += clamp01((ratio - closedRatio) / (openRatio - closedRatio));
			count += 1;
		}

		return count > 0 ? total / count : 0;
	}

	function computeHandRotation(landmarks: Landmark[], handedness: 'Left' | 'Right'): number {
		const wrist = landmarks[0];
		const middleMcp = landmarks[9];
		if (!wrist || !middleMcp) return 0.5;

		const dx = middleMcp.x - wrist.x;
		const dy = middleMcp.y - wrist.y;
		const angle = Math.atan2(dx, -dy);
		const maxAngle = Math.PI / 3;
		const signedAngle = handedness === 'Left' ? angle : -angle;
		return clamp01(0.5 + signedAngle / (2 * maxAngle));
	}

	function computeAverageLandmarkSpeed(
		landmarks: Landmark[],
		previousPoints: Map<number, PreviousPoint>,
		indices: number[],
		now: number,
		scaleOverride?: number
	): number {
		const handScale = scaleOverride ?? computeHandScale(landmarks);
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
					const normalizedDistance = distance / handScale;
					totalSpeed += normalizedDistance / dt;
					count += 1;
				}
			}

			previousPoints.set(index, { x: landmark.x, y: landmark.y, t: now });
		}

		return count > 0 ? totalSpeed / count : 0;
	}

	function smoothEnergy(currentEnergy: number, averageSpeed: number, speedForMaxEnergy: number): number {
		const rawEnergy = clamp01(averageSpeed / speedForMaxEnergy);
		return currentEnergy * 0.8 + rawEnergy * 0.2;
	}

	function getSpeedForMaxHandEnergy(): number {
		const minSpeed = 3.0;
		const maxSpeed = 12.0;
		return maxSpeed - handEnergySensitivity * (maxSpeed - minSpeed);
	}

	function computeLeftHandEnergy(landmarks: Landmark[], now: number): number {
		const speedForMaxEnergy = getSpeedForMaxHandEnergy();
		const averageSpeed = computeAverageLandmarkSpeed(
			landmarks,
			previousLeftHandPoints,
			LEFT_HAND_ENERGY_LANDMARKS,
			now
		);
		leftHandEnergy = smoothEnergy(leftHandEnergy, averageSpeed, speedForMaxEnergy);
		return leftHandEnergy;
	}

	function computeRightHandEnergy(landmarks: Landmark[], now: number): number {
		const speedForMaxEnergy = getSpeedForMaxHandEnergy();
		const averageSpeed = computeAverageLandmarkSpeed(
			landmarks,
			previousRightHandPoints,
			RIGHT_HAND_ENERGY_LANDMARKS,
			now
		);
		rightHandEnergy = smoothEnergy(rightHandEnergy, averageSpeed, speedForMaxEnergy);
		return rightHandEnergy;
	}

	function distance2d(a: Landmark | undefined, b: Landmark | undefined): number {
		if (!a || !b) return 0;
		return Math.hypot(a.x - b.x, a.y - b.y);
	}

	function computePoseScale(poseLandmarks: Landmark[]): number {
		const shoulderWidth = distance2d(poseLandmarks[11], poseLandmarks[12]);
		const leftTorsoHeight = distance2d(poseLandmarks[11], poseLandmarks[23]);
		const rightTorsoHeight = distance2d(poseLandmarks[12], poseLandmarks[24]);
		const scales = [shoulderWidth, leftTorsoHeight, rightTorsoHeight].filter((value) => value > 0);
		const averageScale =
			scales.length > 0 ? scales.reduce((sum, value) => sum + value, 0) / scales.length : 0.08;
		return Math.max(0.08, averageScale);
	}

	function computeLeftPoseWristEnergy(wrist: Landmark, poseScale: number, now: number): number {
		const speedForMaxEnergy = getSpeedForMaxHandEnergy();
		const averageSpeed = computeAverageLandmarkSpeed(
			[wrist],
			previousLeftPoseWristPoints,
			POSE_WRIST_ENERGY_LANDMARKS,
			now,
			poseScale
		);
		leftHandEnergy = smoothEnergy(leftHandEnergy, averageSpeed, speedForMaxEnergy);
		return leftHandEnergy;
	}

	function computeRightPoseWristEnergy(wrist: Landmark, poseScale: number, now: number): number {
		const speedForMaxEnergy = getSpeedForMaxHandEnergy();
		const averageSpeed = computeAverageLandmarkSpeed(
			[wrist],
			previousRightPoseWristPoints,
			POSE_WRIST_ENERGY_LANDMARKS,
			now,
			poseScale
		);
		rightHandEnergy = smoothEnergy(rightHandEnergy, averageSpeed, speedForMaxEnergy);
		return rightHandEnergy;
	}

	async function initDetectors() {
		if (poseLandmarker && handLandmarker && gestureRecognizer) return;
		status = 'Loading models...';
		const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
		[poseLandmarker, handLandmarker, gestureRecognizer] = await Promise.all([
			PoseLandmarker.createFromOptions(vision, {
				baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
				runningMode: 'VIDEO',
				numPoses: 1
			}),
			HandLandmarker.createFromOptions(vision, {
				baseOptions: { modelAssetPath: HAND_MODEL, delegate: 'GPU' },
				runningMode: 'VIDEO',
				numHands: 2
			}),
			GestureRecognizer.createFromOptions(vision, {
				baseOptions: { modelAssetPath: GESTURE_MODEL, delegate: 'GPU' },
				runningMode: 'VIDEO',
				numHands: 2,
				cannedGesturesClassifierOptions: {
					scoreThreshold: 0.6,
					categoryAllowlist: ['Open_Palm', 'Closed_Fist']
				}
			})
		]);
		status = '';
	}

	function resetTrackingState() {
		leftHandActive = false;
		rightHandActive = false;
		previousLeftHandPoints.clear();
		previousRightHandPoints.clear();
		previousLeftPoseWristPoints.clear();
		previousRightPoseWristPoints.clear();
		previousLeftGesture = 'None';
		previousRightGesture = 'None';
		if (rightArmRaised) setNoteValue('Right Arm', false, true);
		if (leftArmRaised) setNoteValue('Left Arm', false, true);
		const leftEnergyBurstMapping = findNoteMapping('Left Energy Burst');
		const rightEnergyBurstMapping = findNoteMapping('Right Energy Burst');
		leftEnergyBurstState = { armed: true, lastTriggerTime: 0 };
		rightEnergyBurstState = { armed: true, lastTriggerTime: 0 };
		if (leftEnergyBurstMapping?.value) {
			leftEnergyBurstMapping.value = false;
			sendNote(leftEnergyBurstMapping, false);
		}
		if (rightEnergyBurstMapping?.value) {
			rightEnergyBurstMapping.value = false;
			sendNote(rightEnergyBurstMapping, false);
		}
		rightArmRaised = false;
		prevRightArmRaised = false;
		leftArmRaised = false;
		prevLeftArmRaised = false;
		leftHandEnergy = 0;
		rightHandEnergy = 0;
		leftHandY = 0.5;
		rightHandY = 0.5;
		resetMidiMappingValues();
		setCcValue('Left Hand Rotation', 0.5);
		setCcValue('Right Hand Rotation', 0.5);
		if (canvasEl) canvasEl.getContext('2d')?.clearRect(0, 0, canvasEl.width, canvasEl.height);
	}

	function stopCurrentVideoSource() {
		cancelAnimationFrame(rafId);
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		if (videoFileUrl) {
			URL.revokeObjectURL(videoFileUrl);
			videoFileUrl = null;
		}
		hasVideoSource = false;
		videoMode = null;
		if (videoEl) {
			videoEl.pause();
			videoEl.srcObject = null;
			videoEl.removeAttribute('src');
			videoEl.controls = false;
			videoEl.load();
		}
	}

	async function startCamera() {
		error = '';
		try {
			stopCurrentVideoSource();
			resetTrackingState();
			stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
			if (videoEl) {
				videoEl.srcObject = stream;
				videoEl.controls = false;
				videoEl.loop = false;
				videoEl.muted = true;
				await videoEl.play();
			}
			await Promise.all([initDetectors(), initMidi()]);
			videoMode = 'camera';
			hasVideoSource = true;
			runLoop();
		} catch {
			error = 'Camera access denied.';
			stream = null;
			status = '';
			hasVideoSource = false;
			videoMode = null;
		}
	}

	async function handleVideoUpload(event: Event) {
		error = '';
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file || !videoEl) return;

		try {
			stopCurrentVideoSource();
			resetTrackingState();
			videoFileUrl = URL.createObjectURL(file);
			videoEl.srcObject = null;
			videoEl.src = videoFileUrl;
			videoEl.controls = true;
			videoEl.loop = true;
			videoEl.muted = true;
			await Promise.all([initDetectors(), initMidi()]);
			await videoEl.play();
			videoMode = 'upload';
			hasVideoSource = true;
			runLoop();
		} catch {
			error = 'Unable to load video file.';
			stopCurrentVideoSource();
			resetTrackingState();
		} finally {
			input.value = '';
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
		if (!videoEl || !canvasEl || !poseLandmarker || !handLandmarker || !gestureRecognizer || !hasVideoSource) return;

		if (videoEl.readyState >= 2) {
			const w = videoEl.videoWidth;
			const h = videoEl.videoHeight;
			if (canvasEl.width !== w) canvasEl.width = w;
			if (canvasEl.height !== h) canvasEl.height = h;

			const ctx = canvasEl.getContext('2d')!;
			ctx.clearRect(0, 0, w, h);
			const now = performance.now();
			const shouldSendMidi = now - lastMidiSend > 33;
			let sentMidiThisFrame = false;
			let currentPoseLandmarks: Landmark[] | undefined;
			let leftPoseWrist: Landmark | undefined;
			let rightPoseWrist: Landmark | undefined;
			let poseScale = 0.08;

			const pose = poseLandmarker.detectForVideo(videoEl, now);
			ctx.strokeStyle = 'rgba(255,255,255,0.45)';
			ctx.lineWidth = 1.5;
			for (const landmarks of pose.landmarks) {
				currentPoseLandmarks = landmarks;
				drawConnections(ctx, landmarks, PoseLandmarker.POSE_CONNECTIONS, w, h);
				drawJoints(ctx, landmarks, 3, w, h);
				const leftFootLandmarks = [
					landmarks[LEFT_ANKLE],
					landmarks[LEFT_HEEL],
					landmarks[LEFT_FOOT_INDEX]
				];
				const rightFootLandmarks = [
					landmarks[RIGHT_ANKLE],
					landmarks[RIGHT_HEEL],
					landmarks[RIGHT_FOOT_INDEX]
				];
				leftPoseWrist = landmarks[15];
				rightPoseWrist = landmarks[16];
				poseScale = computePoseScale(landmarks);

				const rRaised = landmarks[16].y < landmarks[12].y;
				rightArmRaised = rRaised;
				setNoteValue('Right Arm', rRaised);
				if (rRaised !== prevRightArmRaised) {
					setNoteValue('Right Arm', rRaised, true);
					prevRightArmRaised = rRaised;
				}

				const lRaised = landmarks[15].y < landmarks[11].y;
				leftArmRaised = lRaised;
				setNoteValue('Left Arm', lRaised);
				if (lRaised !== prevLeftArmRaised) {
					setNoteValue('Left Arm', lRaised, true);
					prevLeftArmRaised = lRaised;
				}

				const leftFoot = leftFootLandmarks.some(Boolean) ? computeFootPoint(landmarks, 'left') : undefined;
				const rightFoot = rightFootLandmarks.some(Boolean)
					? computeFootPoint(landmarks, 'right')
					: undefined;
				const leftFootOnScreen = isLandmarkOnScreen(leftFoot, 0.08);
				const rightFootOnScreen = isLandmarkOnScreen(rightFoot, 0.08);

				const leftFootX =
					leftFoot && leftFootOnScreen ? computeRelativeFootX(leftFoot, landmarks) : 0;
				const leftFootY =
					leftFoot && leftFootOnScreen ? computeRelativeFootY(leftFoot, landmarks) : 0;
				const rightFootX =
					rightFoot && rightFootOnScreen ? computeRelativeFootX(rightFoot, landmarks) : 0;
				const rightFootY =
					rightFoot && rightFootOnScreen ? computeRelativeFootY(rightFoot, landmarks) : 0;
				setCcValue('Left Foot X', leftFootX);
				setCcValue('Left Foot Y', leftFootY);
				setCcValue('Right Foot X', rightFootX);
				setCcValue('Right Foot Y', rightFootY);

				if (shouldSendMidi) {
					setCcValue('Left Foot X', leftFootX, true);
					setCcValue('Left Foot Y', leftFootY, true);
					setCcValue('Right Foot X', rightFootX, true);
					setCcValue('Right Foot Y', rightFootY, true);
					sentMidiThisFrame = true;
				}
			}

			if (!currentPoseLandmarks) {
				setCcValue('Left Foot X', 0);
				setCcValue('Left Foot Y', 0);
				setCcValue('Right Foot X', 0);
				setCcValue('Right Foot Y', 0);
				if (shouldSendMidi) {
					setCcValue('Left Foot X', 0, true);
					setCcValue('Left Foot Y', 0, true);
					setCcValue('Right Foot X', 0, true);
					setCcValue('Right Foot Y', 0, true);
					sentMidiThisFrame = true;
				}
			}

			const hands = handLandmarker.detectForVideo(videoEl, now);
			const gestureResults = gestureRecognizer.recognizeForVideo(videoEl, now);
			ctx.strokeStyle = 'rgba(255,255,255,0.75)';
			ctx.lineWidth = 1;
			leftHandActive = false;
			rightHandActive = false;
			const leftGestureIndex = gestureResults.handednesses.findIndex(
				(entry) => entry?.[0]?.categoryName === 'Left'
			);
			const rightGestureIndex = gestureResults.handednesses.findIndex(
				(entry) => entry?.[0]?.categoryName === 'Right'
			);
			const leftGesture = leftGestureIndex >= 0 ? gestureResults.gestures[leftGestureIndex]?.[0] : undefined;
			const rightGesture =
				rightGestureIndex >= 0 ? gestureResults.gestures[rightGestureIndex]?.[0] : undefined;
			for (let i = 0; i < hands.landmarks.length; i++) {
				const landmarks = hands.landmarks[i];
				drawConnections(ctx, landmarks, HandLandmarker.HAND_CONNECTIONS, w, h);
				drawJoints(ctx, landmarks, 2.5, w, h);
				const handedness = hands.handednesses[i]?.[0]?.categoryName;
				const gesture = handedness === 'Left' ? leftGesture : handedness === 'Right' ? rightGesture : undefined;
				const gestureName = gesture?.categoryName as HandGestureName | undefined;
				const gestureScore = gesture?.score ?? 0;
				if (handedness === 'Left') {
					leftHandY = currentPoseLandmarks
						? computeRelativeHandY(landmarks[0], currentPoseLandmarks)
						: clamp01(landmarks[0].y);
					const leftHandX = currentPoseLandmarks
						? computeRelativeHandX(landmarks[0], currentPoseLandmarks)
						: clamp01(landmarks[0].x);
					leftHandActive = true;
					previousLeftPoseWristPoints.clear();
					setCcValue('Left Hand Y', leftHandY);
					setCcValue('Left Hand X', leftHandX);
					const leftHandEnergyMapping = findCcMapping('Left Hand Energy');
					const leftHandRotation = computeHandRotation(landmarks, 'Left');
					const onScreen = isHandOnScreen(landmarks);
					if (!onScreen) {
						previousLeftHandPoints.clear();
						leftHandEnergy = 0;
						previousLeftGesture = 'None';
						if (leftHandEnergyMapping) leftHandEnergyMapping.value = 0;
						setCcValue('Left Hand Openness', 0);
						setCcValue('Left Hand Rotation', 0.5);
						if (shouldSendMidi) {
							setCcValue('Left Hand Y', leftHandY, true);
							setCcValue('Left Hand X', leftHandX, true);
							setCcValue('Left Hand Energy', 0, true);
							setCcValue('Left Hand Openness', 0, true);
							setCcValue('Left Hand Rotation', 0.5, true);
							sentMidiThisFrame = true;
						}
						continue;
					}
					const openness = computeHandOpenness(landmarks);
					setCcValue('Left Hand Openness', openness);
					setCcValue('Left Hand Rotation', leftHandRotation);
					if (
						(gestureName === 'Open_Palm' || gestureName === 'Closed_Fist') &&
						gestureScore >= 0.6
					) {
						previousLeftGesture = handleGestureTrigger(
							'Left',
							gestureName,
							previousLeftGesture
						);
					}
					const energy = computeLeftHandEnergy(landmarks, now);
					if (leftHandEnergyMapping) leftHandEnergyMapping.value = energy;
					if (shouldSendMidi) {
						setCcValue('Left Hand Y', leftHandY, true);
						setCcValue('Left Hand X', leftHandX, true);
						setCcValue('Left Hand Energy', energy, true);
						setCcValue('Left Hand Openness', openness, true);
						setCcValue('Left Hand Rotation', leftHandRotation, true);
						sentMidiThisFrame = true;
					}
				} else if (handedness === 'Right') {
					rightHandY = currentPoseLandmarks
						? computeRelativeHandY(landmarks[0], currentPoseLandmarks)
						: clamp01(landmarks[0].y);
					const rightHandX = currentPoseLandmarks
						? computeRelativeHandX(landmarks[0], currentPoseLandmarks)
						: clamp01(landmarks[0].x);
					rightHandActive = true;
					previousRightPoseWristPoints.clear();
					setCcValue('Right Hand Y', rightHandY);
					setCcValue('Right Hand X', rightHandX);
					const rightHandEnergyMapping = findCcMapping('Right Hand Energy');
					const rightHandRotation = computeHandRotation(landmarks, 'Right');
					const onScreen = isHandOnScreen(landmarks);
					if (!onScreen) {
						previousRightHandPoints.clear();
						rightHandEnergy = 0;
						previousRightGesture = 'None';
						if (rightHandEnergyMapping) rightHandEnergyMapping.value = 0;
						setCcValue('Right Hand Openness', 0);
						setCcValue('Right Hand Rotation', 0.5);
						if (shouldSendMidi) {
							setCcValue('Right Hand Y', rightHandY, true);
							setCcValue('Right Hand X', rightHandX, true);
							setCcValue('Right Hand Energy', 0, true);
							setCcValue('Right Hand Openness', 0, true);
							setCcValue('Right Hand Rotation', 0.5, true);
							sentMidiThisFrame = true;
						}
						continue;
					}
					const openness = computeHandOpenness(landmarks);
					setCcValue('Right Hand Openness', openness);
					setCcValue('Right Hand Rotation', rightHandRotation);
					if (
						(gestureName === 'Open_Palm' || gestureName === 'Closed_Fist') &&
						gestureScore >= 0.6
					) {
						previousRightGesture = handleGestureTrigger(
							'Right',
							gestureName,
							previousRightGesture
						);
					}
					const energy = computeRightHandEnergy(landmarks, now);
					if (rightHandEnergyMapping) rightHandEnergyMapping.value = energy;
					if (shouldSendMidi) {
						setCcValue('Right Hand Y', rightHandY, true);
						setCcValue('Right Hand X', rightHandX, true);
						setCcValue('Right Hand Energy', energy, true);
						setCcValue('Right Hand Openness', openness, true);
						setCcValue('Right Hand Rotation', rightHandRotation, true);
						sentMidiThisFrame = true;
					}
				}
			}

			if (!leftHandActive) {
				previousLeftGesture = 'None';
				previousLeftHandPoints.clear();
				setCcValue('Left Hand Openness', 0);
				setCcValue('Left Hand Rotation', 0.5);
				const leftPoseWristOnScreen = isLandmarkOnScreen(leftPoseWrist, 0.08);
				if (leftPoseWrist && leftPoseWristOnScreen) {
					leftHandY = currentPoseLandmarks
						? computeRelativeHandY(leftPoseWrist, currentPoseLandmarks)
						: clamp01(leftPoseWrist.y);
					const leftHandX = currentPoseLandmarks
						? computeRelativeHandX(leftPoseWrist, currentPoseLandmarks)
						: clamp01(leftPoseWrist.x);
					setCcValue('Left Hand Y', leftHandY);
					setCcValue('Left Hand X', leftHandX);
					const energy = computeLeftPoseWristEnergy(leftPoseWrist, poseScale, now);
					setCcValue('Left Hand Energy', energy);
					if (shouldSendMidi) {
						setCcValue('Left Hand Y', leftHandY, true);
						setCcValue('Left Hand X', leftHandX, true);
						setCcValue('Left Hand Energy', energy, true);
						setCcValue('Left Hand Openness', 0, true);
						setCcValue('Left Hand Rotation', 0.5, true);
						sentMidiThisFrame = true;
					}
				} else {
					previousLeftPoseWristPoints.clear();
					leftHandEnergy = 0;
					setCcValue('Left Hand Energy', 0);
					if (shouldSendMidi) {
						setCcValue('Left Hand Energy', 0, true);
						setCcValue('Left Hand Openness', 0, true);
						setCcValue('Left Hand Rotation', 0.5, true);
						sentMidiThisFrame = true;
					}
				}
			}

			if (!rightHandActive) {
				previousRightGesture = 'None';
				previousRightHandPoints.clear();
				setCcValue('Right Hand Openness', 0);
				setCcValue('Right Hand Rotation', 0.5);
				const rightPoseWristOnScreen = isLandmarkOnScreen(rightPoseWrist, 0.08);
				if (rightPoseWrist && rightPoseWristOnScreen) {
					rightHandY = currentPoseLandmarks
						? computeRelativeHandY(rightPoseWrist, currentPoseLandmarks)
						: clamp01(rightPoseWrist.y);
					const rightHandX = currentPoseLandmarks
						? computeRelativeHandX(rightPoseWrist, currentPoseLandmarks)
						: clamp01(rightPoseWrist.x);
					setCcValue('Right Hand Y', rightHandY);
					setCcValue('Right Hand X', rightHandX);
					const energy = computeRightPoseWristEnergy(rightPoseWrist, poseScale, now);
					setCcValue('Right Hand Energy', energy);
					if (shouldSendMidi) {
						setCcValue('Right Hand Y', rightHandY, true);
						setCcValue('Right Hand X', rightHandX, true);
						setCcValue('Right Hand Energy', energy, true);
						setCcValue('Right Hand Openness', 0, true);
						setCcValue('Right Hand Rotation', 0.5, true);
						sentMidiThisFrame = true;
					}
				} else {
					previousRightPoseWristPoints.clear();
					rightHandEnergy = 0;
					setCcValue('Right Hand Energy', 0);
					if (shouldSendMidi) {
						setCcValue('Right Hand Energy', 0, true);
						setCcValue('Right Hand Openness', 0, true);
						setCcValue('Right Hand Rotation', 0.5, true);
						sentMidiThisFrame = true;
					}
				}
			}

			updateThresholdNoteTrigger(
				leftHandEnergy,
				leftEnergyBurstState,
				findNoteMapping('Left Energy Burst'),
				now
			);
			updateThresholdNoteTrigger(
				rightHandEnergy,
				rightEnergyBurstState,
				findNoteMapping('Right Energy Burst'),
				now
			);

			if (sentMidiThisFrame) lastMidiSend = now;

		}

		rafId = requestAnimationFrame(runLoop);
	}

	function stopVideo() {
		stopCurrentVideoSource();
		status = '';
		resetTrackingState();
	}
</script>

<div class="flex h-screen overflow-hidden bg-zinc-950">
	<!-- main area -->
	<div class="flex flex-1 flex-col items-center justify-center gap-6 p-8 min-w-0">
		<div class="flex items-stretch gap-3 w-full max-w-2xl {hasVideoSource ? '' : 'hidden'}">
			<div class="relative flex-1 aspect-video">
				<video
					bind:this={videoEl}
					autoplay
					playsinline
					muted
					controls={videoMode === 'upload'}
					class="h-full w-full border border-zinc-800 object-cover"
				></video>
				<canvas bind:this={canvasEl} class="pointer-events-none absolute inset-0 h-full w-full"></canvas>
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

		<div class="flex items-center gap-3">
			<button
				onclick={hasVideoSource ? stopVideo : startCamera}
				class="cursor-pointer rounded-none border border-zinc-600 px-6 py-2 font-mono text-xs tracking-widest text-zinc-200 uppercase transition-colors hover:bg-zinc-800"
			>
				{hasVideoSource ? 'Stop' : 'Start Camera'}
			</button>
			<label
				class="cursor-pointer rounded-none border border-zinc-700 px-6 py-2 font-mono text-xs tracking-widest text-zinc-300 uppercase transition-colors hover:bg-zinc-900"
			>
				Upload Video
				<input type="file" accept="video/*" class="hidden" onchange={handleVideoUpload} />
			</label>
		</div>

		{#if hasVideoSource}
			<!-- MIDI device controls -->
			<div class="flex flex-wrap items-center gap-3">
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
				<div class="ml-2 flex items-center gap-2">
					<span class="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">
						ENERGY SENS
					</span>
					<input
						type="range"
						bind:value={handEnergySensitivity}
						min="0"
						max="1"
						step="0.01"
						class="h-1.5 w-24 cursor-pointer accent-zinc-300"
					/>
					<span class="w-9 text-right font-mono text-[10px] tabular-nums text-zinc-500">
						{Math.round(handEnergySensitivity * 100)}%
					</span>
				</div>
			</div>

			<!-- mappings grid -->
			<div class="w-full max-w-2xl max-h-64 overflow-y-auto border border-zinc-800 p-3">
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
</div>

<!-- peer button -->
<button
	onclick={() => (peerModalOpen = true)}
	class="fixed right-4 top-4 z-20 cursor-pointer rounded-none border border-zinc-700 px-3 py-1.5 font-mono text-[10px] tracking-widest text-zinc-500 uppercase transition-colors hover:border-zinc-500 hover:text-zinc-300"
>
	Peer
</button>

<PeerModal bind:open={peerModalOpen} />
