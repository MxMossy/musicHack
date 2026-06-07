type Boid = {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
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
const CONTROLLER_BOIDS_PER_PHONE = 1;
const MAX_SPEED = 2.5;
const MIN_SPEED = 0.8;
const SEP_RADIUS = 30;
const ALI_RADIUS = 80;
const COH_RADIUS = 80;
const SEP_WEIGHT = 1.6;
const ALI_WEIGHT = 1.0;
const COH_WEIGHT = 1.0;
const STEER_FORCE = 0.08;
const TRI_LENGTH = 14;
const TRI_HALF_BASE = 5;
const EXCITABILITY_MIN = 0.45;
const EXCITABILITY_MAX = 1.8;
const EXCITEMENT_EASE = 0.08;
const EXCITE_STEER_BOOST = 0.55;
const EXCITE_SPEED_BOOST = 0.8;
const EXCITE_JITTER_FORCE = 0.035;
const EXCITE_SEPARATION_BOOST = 0.9;
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

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }

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
			usedHues.every(
				(usedHue) => circularHueDistance(usedHue, hue) >= CONTROLLER_HUE_MIN_DISTANCE
			)
		) {
			return hue;
		}
	}

	return Math.floor(Math.random() * 360);
}

function applyControllerColor(boid: Boid) {
	if (!ENABLE_CONTROLLER_COLORS) return;
	boid.colorHue = createUniqueControllerHue(boid.id);
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
	const claimed = new Set(Array.from(controllers.values()).flatMap((controller) => controller.boidIds));
	const boidIds = boids
		.filter((boid) => !claimed.has(boid.id))
		.slice(0, Math.max(0, CONTROLLER_BOIDS_PER_PHONE))
		.map((boid) => {
			applyControllerColor(boid);
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
		const steerForce = STEER_FORCE * (1 + excitement * EXCITE_STEER_BOOST);
		const maxSpeed = MAX_SPEED + excitement * EXCITE_SPEED_BOOST;
		const minSpeed = MIN_SPEED + excitement * EXCITE_SPEED_BOOST * 0.2;
		const separationWeight = SEP_WEIGHT * (1 + excitement * EXCITE_SEPARATION_BOOST);

		let sepX = 0, sepY = 0, sepCount = 0;
		let aliX = 0, aliY = 0, aliCount = 0;
		let cohX = 0, cohY = 0, cohCount = 0;

		for (const n of boids) {
			if (n === b) continue;
			let dx = n.x - b.x;
			let dy = n.y - b.y;
			if (dx > w / 2) dx -= w; else if (dx < -w / 2) dx += w;
			if (dy > h / 2) dy -= h; else if (dy < -h / 2) dy += h;
			const dist = Math.sqrt(dx * dx + dy * dy);
			if (dist < SEP_RADIUS && dist > 0) { sepX -= dx / dist; sepY -= dy / dist; sepCount++; }
			if (dist < ALI_RADIUS) { aliX += n.vx; aliY += n.vy; aliCount++; }
			if (dist < COH_RADIUS) { cohX += n.x; cohY += n.y; cohCount++; }
		}

		let steerX = 0, steerY = 0;
		if (sepCount > 0) { const m = Math.sqrt(sepX*sepX+sepY*sepY); if (m>0) { steerX+=(sepX/m)*steerForce*separationWeight; steerY+=(sepY/m)*steerForce*separationWeight; } }
		if (aliCount > 0) { const ax=aliX/aliCount-b.vx, ay=aliY/aliCount-b.vy, m=Math.sqrt(ax*ax+ay*ay); if (m>0) { steerX+=(ax/m)*steerForce*ALI_WEIGHT; steerY+=(ay/m)*steerForce*ALI_WEIGHT; } }
		if (cohCount > 0) { const cx=cohX/cohCount-b.x, cy=cohY/cohCount-b.y, m=Math.sqrt(cx*cx+cy*cy); if (m>0) { steerX+=(cx/m)*steerForce*COH_WEIGHT; steerY+=(cy/m)*steerForce*COH_WEIGHT; } }
		if (excitement > 0.03) { steerX += (Math.random()*2-1)*EXCITE_JITTER_FORCE*excitement; steerY += (Math.random()*2-1)*EXCITE_JITTER_FORCE*excitement; }

		b.vx += steerX; b.vy += steerY;
		const speed = Math.sqrt(b.vx*b.vx+b.vy*b.vy);
		if (speed > maxSpeed) { b.vx=(b.vx/speed)*maxSpeed; b.vy=(b.vy/speed)*maxSpeed; }
		else if (speed < minSpeed && speed > 0) { b.vx=(b.vx/speed)*minSpeed; b.vy=(b.vy/speed)*minSpeed; }
		b.x = ((b.x + b.vx) % w + w) % w;
		b.y = ((b.y + b.vy) % h + h) % h;
	}
}

function drawBoid(b: Boid) {
	if (!ctx) return;
	const excitement = b.excitement;
	const sizeScale = 1 + excitement * 0.3;
	ctx.save();
	ctx.translate(b.x, b.y);
	ctx.rotate(Math.atan2(b.vy, b.vx));
	ctx.scale(sizeScale, sizeScale);
	ctx.beginPath();
	ctx.moveTo(TRI_LENGTH, 0);
	ctx.lineTo(0, TRI_HALF_BASE);
	ctx.lineTo(0, -TRI_HALF_BASE);
	ctx.closePath();
	ctx.fillStyle = `hsla(${b.colorHue}, 88%, 64%, ${0.85 + excitement * 0.12})`;
	ctx.strokeStyle = `hsla(${b.colorHue}, 96%, 90%, ${0.5 + excitement * 0.35})`;
	ctx.lineWidth = 0.8 + excitement * 0.8;
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
			if (canvas) { canvas.width = w; canvas.height = h; }
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
