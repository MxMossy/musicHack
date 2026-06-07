type Boid = {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	sweepPhase: number;
	sweepRate: number;
	sweepForce: number;
	excitedTurnDirection: number;
	excitedTurnFramesRemaining: number;
	excitedTurnCooldownFramesRemaining: number;
	colorHue: number;
	excitability: number;
	excitement: number;
	targetExcitement: number;
};

type BoidController = {
	clientId: string;
	boidIds: string[];
	lastSeen: number;
};

const BOID_COUNT = 30;
const ENABLE_CONTROLLER_COLORS = true;
const CONTROLLER_BOIDS_PER_PHONE = 5;
const MAX_SPEED = 2.5;
const MIN_SPEED = 0.8;
const STEER_FORCE = 0.08;
const SWEEP_RATE_MIN = 0.018;
const SWEEP_RATE_MAX = 0.045;
const SWEEP_FORCE_VARIATION = 0.06;
const TRI_LENGTH = 14;
const TRI_HALF_BASE = 5;
const TRI_CENTER_X = TRI_LENGTH / 3;
const EXCITABILITY_MIN = 0.45;
const EXCITABILITY_MAX = 1.8;
const EXCITEMENT_EASE = 0.08;
const EXCITE_STEER_BOOST = 0.55;
const EXCITE_SPEED_BOOST = 1.35;
const EXCITE_TURN_FORCE = 0.18;
const EXCITE_TURN_REFRESH_MIN = 6;
const EXCITE_TURN_REFRESH_MAX = 16;
const EXCITE_TURN_COOLDOWN_MIN = 7;
const EXCITE_TURN_COOLDOWN_MAX = 14;
const EXCITE_TURN_TRIGGER_BASE = 0.015;
const EXCITE_TURN_TRIGGER_BOOST = 0.08;
const CONTROLLER_TIMEOUT_MS = 3000;
const DEFAULT_BOID_HUE = 196;
const CONTROLLER_HUE_MIN_DISTANCE = 24;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let w = 0;
let h = 0;
let boids: Boid[] = [];
let controllers = new Map<string, BoidController>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function clamp01(v: number) {
	return Math.max(0, Math.min(1, v));
}

function lerp(a: number, b: number, t: number) {
	return a + (b - a) * t;
}

type TurnState = {
	direction: number;
	framesRemaining: number;
	cooldownFramesRemaining?: number;
};

type ExcitedTurnOptions = {
	excitement: number;
	turnState: TurnState;
	randomValue: number;
};

export function computeExcitedTurnSteering(
	velocity: { vx: number; vy: number },
	{ excitement, turnState, randomValue }: ExcitedTurnOptions
) {
	const desiredSpeed = MAX_SPEED + excitement * (EXCITE_SPEED_BOOST + 0.6);
	if (excitement <= 0.03) {
		return {
			steerX: 0,
			steerY: 0,
			desiredSpeed,
			nextTurnState: { direction: 0, framesRemaining: 0 }
		};
	}

	let nextDirection = turnState.direction;
	let nextFramesRemaining = Math.max(0, turnState.framesRemaining - 1);
	let nextCooldownFramesRemaining = Math.max(0, (turnState.cooldownFramesRemaining ?? 0) - 1);
	const turnTriggerChance = EXCITE_TURN_TRIGGER_BASE + excitement * EXCITE_TURN_TRIGGER_BOOST;
	const turnDuration = Math.round(
		lerp(EXCITE_TURN_REFRESH_MAX, EXCITE_TURN_REFRESH_MIN, excitement)
	);

	if (
		nextFramesRemaining === 0 &&
		nextCooldownFramesRemaining === 0 &&
		randomValue > 1 - turnTriggerChance
	) {
		nextDirection = randomValue < 0.5 ? -1 : 1;
		nextFramesRemaining = turnDuration;
	}

	if (nextDirection === 0 || nextFramesRemaining === 0) {
		return {
			steerX: 0,
			steerY: 0,
			desiredSpeed,
			nextTurnState: {
				direction: 0,
				framesRemaining: 0,
				cooldownFramesRemaining: nextCooldownFramesRemaining
			}
		};
	}

	const speed = Math.sqrt(velocity.vx * velocity.vx + velocity.vy * velocity.vy) || desiredSpeed;
	const normX = speed > 0 ? velocity.vx / speed : 1;
	const normY = speed > 0 ? velocity.vy / speed : 0;
	const tangentX = -normY * nextDirection;
	const tangentY = normX * nextDirection;
	const arcPhase = 1 - (nextFramesRemaining - 1) / Math.max(1, turnDuration - 1);
	const arcEase = Math.sin(arcPhase * Math.PI);
	const turnForce = EXCITE_TURN_FORCE * (0.35 + excitement * 1.05) * Math.max(0.2, arcEase);
	const speedBoost = Math.max(0, desiredSpeed - speed) * 0.08;
	const finishedTurn = nextFramesRemaining === 1;
	if (finishedTurn) {
		nextDirection = 0;
		nextFramesRemaining = 0;
		nextCooldownFramesRemaining = Math.round(
			lerp(EXCITE_TURN_COOLDOWN_MAX, EXCITE_TURN_COOLDOWN_MIN, excitement)
		);
	}

	return {
		steerX: tangentX * turnForce + normX * speedBoost,
		steerY: tangentY * turnForce + normY * speedBoost,
		desiredSpeed,
		nextTurnState: {
			direction: nextDirection,
			framesRemaining: nextFramesRemaining,
			cooldownFramesRemaining: nextCooldownFramesRemaining
		}
	};
}

function circularHueDistance(a: number, b: number) {
	const delta = Math.abs(a - b);
	return Math.min(delta, 360 - delta);
}

function getUsedControllerHues(excludeBoidId?: string): number[] {
	return Array.from(controllers.values())
		.flatMap((controller) => controller.boidIds)
		.filter((boidId) => boidId !== excludeBoidId)
		.map((boidId) => boids.find((candidate) => candidate.id === boidId)?.colorHue)
		.filter((hue): hue is number => hue != null && hue !== DEFAULT_BOID_HUE);
}

function createUniqueControllerHue(excludeBoidId?: string): number {
	const usedHues = getUsedControllerHues(excludeBoidId);
	for (let attempt = 0; attempt < 24; attempt += 1) {
		const hue = Math.floor(Math.random() * 360);
		if (
			usedHues.every((usedHue) => circularHueDistance(usedHue, hue) >= CONTROLLER_HUE_MIN_DISTANCE)
		) {
			return hue;
		}
	}

	return Math.floor(Math.random() * 360);
}

function applyControllerColor(boid: Boid, hue: number) {
	if (!ENABLE_CONTROLLER_COLORS) return;
	boid.colorHue = hue;
}

function resetBoidColor(boid: Boid) {
	boid.colorHue = DEFAULT_BOID_HUE;
}

function initBoids(width: number, height: number): Boid[] {
	return Array.from({ length: BOID_COUNT }, (_, i) => {
		const angle = Math.random() * Math.PI * 2;
		const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
		return {
			id: `boid-${i}`,
			x: Math.random() * width,
			y: Math.random() * height,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed,
			sweepPhase: Math.random() * Math.PI * 2,
			sweepRate: lerp(SWEEP_RATE_MIN, SWEEP_RATE_MAX, Math.random()),
			sweepForce: STEER_FORCE * lerp(0.7, 1 + SWEEP_FORCE_VARIATION, Math.random()),
			excitedTurnDirection: 0,
			excitedTurnFramesRemaining: 0,
			excitedTurnCooldownFramesRemaining: 0,
			colorHue: DEFAULT_BOID_HUE,
			excitability: EXCITABILITY_MIN + Math.random() * (EXCITABILITY_MAX - EXCITABILITY_MIN),
			excitement: 0,
			targetExcitement: 0
		};
	});
}

function setBoidExcitement(boidId: string, value: number) {
	const boid = boids.find((b) => b.id === boidId);
	if (boid) boid.targetExcitement = clamp01(value);
}

function assignClientToBoids(clientId: string): string[] {
	const existing = controllers.get(clientId);
	if (existing) return existing.boidIds;
	const claimed = new Set(
		Array.from(controllers.values()).flatMap((controller) => controller.boidIds)
	);
	const controllerHue = createUniqueControllerHue();
	const boidIds = boids
		.filter((boid) => !claimed.has(boid.id))
		.slice(0, Math.max(0, CONTROLLER_BOIDS_PER_PHONE))
		.map((boid) => {
			applyControllerColor(boid, controllerHue);
			return boid.id;
		});
	if (boidIds.length === 0) return [];
	controllers.set(clientId, { clientId, boidIds, lastSeen: performance.now() });
	return boidIds;
}

function releaseClientBoid(clientId: string) {
	const controller = controllers.get(clientId);
	if (!controller) return;
	for (const boidId of controller.boidIds) {
		setBoidExcitement(boidId, 0);
		const boid = boids.find((candidate) => candidate.id === boidId);
		if (boid) resetBoidColor(boid);
	}
	controllers.delete(clientId);
}

function setClientExcitement(clientId: string, value: number) {
	const boidIds = assignClientToBoids(clientId);
	if (boidIds.length === 0) return;
	const controller = controllers.get(clientId);
	if (controller) controller.lastSeen = performance.now();
	for (const boidId of boidIds) {
		setBoidExcitement(boidId, value);
	}
}

function releaseStaleControllers(now: number) {
	for (const [clientId, controller] of controllers) {
		if (now - controller.lastSeen > CONTROLLER_TIMEOUT_MS) releaseClientBoid(clientId);
	}
}

function updateBoids() {
	for (const b of boids) {
		const excitementTarget = clamp01(b.targetExcitement * b.excitability);
		b.excitement += (excitementTarget - b.excitement) * EXCITEMENT_EASE;

		const excitement = b.excitement;
		const maxSpeed = MAX_SPEED + excitement * EXCITE_SPEED_BOOST;
		const minSpeed = MIN_SPEED + excitement * EXCITE_SPEED_BOOST * 0.2;
		const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
		const normX = speed > 0 ? b.vx / speed : 1;
		const normY = speed > 0 ? b.vy / speed : 0;
		const sweepTurn = Math.sin(b.sweepPhase);
		const sweepForce = b.sweepForce * (1 + excitement * EXCITE_STEER_BOOST);
		let steerX = -normY * sweepTurn * sweepForce;
		let steerY = normX * sweepTurn * sweepForce;
		b.sweepPhase += b.sweepRate * (1 + excitement * 0.35);

		const excitedTurn = computeExcitedTurnSteering(
			{ vx: b.vx, vy: b.vy },
			{
				excitement,
				turnState: {
					direction: b.excitedTurnDirection,
					framesRemaining: b.excitedTurnFramesRemaining,
					cooldownFramesRemaining: b.excitedTurnCooldownFramesRemaining
				},
				randomValue: Math.random()
			}
		);
		b.excitedTurnDirection = excitedTurn.nextTurnState.direction;
		b.excitedTurnFramesRemaining = excitedTurn.nextTurnState.framesRemaining;
		b.excitedTurnCooldownFramesRemaining = excitedTurn.nextTurnState.cooldownFramesRemaining ?? 0;
		steerX += excitedTurn.steerX;
		steerY += excitedTurn.steerY;

		b.vx += steerX;
		b.vy += steerY;
		const nextSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
		const excitedMinSpeed = Math.max(
			minSpeed,
			excitedTurn.desiredSpeed * (0.76 + excitement * 0.08)
		);
		const targetMinSpeed = excitement > 0.03 ? excitedMinSpeed : minSpeed;
		if (nextSpeed > maxSpeed) {
			b.vx = (b.vx / nextSpeed) * maxSpeed;
			b.vy = (b.vy / nextSpeed) * maxSpeed;
		} else if (nextSpeed < targetMinSpeed && nextSpeed > 0) {
			b.vx = (b.vx / nextSpeed) * targetMinSpeed;
			b.vy = (b.vy / nextSpeed) * targetMinSpeed;
		}
		b.x = (((b.x + b.vx) % w) + w) % w;
		b.y = (((b.y + b.vy) % h) + h) % h;
	}
}

function drawBoid(b: Boid) {
	if (!ctx) return;
	const excitement = b.excitement;
	const sizeScale = 1 + excitement * 0.75;
	const fillLightness = 64 + excitement * 12;
	const strokeLightness = 90 + excitement * 6;
	const glowAlpha = 0.08 + excitement * 0.24;
	ctx.save();
	ctx.translate(b.x, b.y);
	ctx.rotate(Math.atan2(b.vy, b.vx));
	ctx.scale(sizeScale, sizeScale);
	if (excitement > 0.08) {
		ctx.beginPath();
		ctx.arc(TRI_CENTER_X, 0, TRI_LENGTH * (0.9 + excitement * 0.8), 0, Math.PI * 2);
		ctx.fillStyle = `hsla(${b.colorHue}, 100%, ${fillLightness}%, ${glowAlpha})`;
		ctx.fill();
	}
	ctx.beginPath();
	ctx.moveTo(TRI_LENGTH, 0);
	ctx.lineTo(0, TRI_HALF_BASE);
	ctx.lineTo(0, -TRI_HALF_BASE);
	ctx.closePath();
	ctx.fillStyle = `hsla(${b.colorHue}, 96%, ${fillLightness}%, ${0.88 + excitement * 0.12})`;
	ctx.strokeStyle = `hsla(${b.colorHue}, 100%, ${strokeLightness}%, ${0.55 + excitement * 0.4})`;
	ctx.lineWidth = 0.8 + excitement * 1.6;
	ctx.fill();
	ctx.stroke();
	ctx.restore();
}

function loop() {
	if (!ctx) return;
	const now = performance.now();
	ctx.fillStyle = 'rgba(10, 10, 15, 0.25)';
	ctx.fillRect(0, 0, w, h);
	releaseStaleControllers(now);
	updateBoids();
	for (const b of boids) drawBoid(b);
}

if (typeof self !== 'undefined') {
	self.onmessage = (e) => {
		const msg = e.data;
		switch (msg.type) {
			case 'init':
				canvas = msg.canvas as OffscreenCanvas;
				w = msg.w;
				h = msg.h;
				canvas.width = w;
				canvas.height = h;
				ctx = canvas.getContext('2d');
				boids = initBoids(w, h);
				intervalId = setInterval(loop, 1000 / 60);
				break;
			case 'resize':
				w = msg.w;
				h = msg.h;
				if (canvas) {
					canvas.width = w;
					canvas.height = h;
				}
				break;
			case 'setClientExcitement':
				setClientExcitement(msg.clientId, msg.value);
				break;
			case 'setBoidExcitement':
				setBoidExcitement(msg.boidId, msg.value);
				break;
			case 'stop':
				if (intervalId !== null) clearInterval(intervalId);
				break;
		}
	};
}
