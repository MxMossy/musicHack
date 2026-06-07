<script lang="ts">
	import { onMount } from 'svelte';

	type Boid = {
		id: string;
		x: number;
		y: number;
		vx: number;
		vy: number;
		excitability: number;
		excitement: number;
		targetExcitement: number;
	};

	type BoidController = {
		clientId: string;
		boidId: string;
		lastSeen: number;
	};

	const BOID_COUNT = 50;
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

	let canvasEl = $state<HTMLCanvasElement | undefined>();

	let boids: Boid[] = [];
	let controllers = new Map<string, BoidController>();
	let rafId: number;
	let w = 0;
	let h = 0;
	let boidExcitementApi:
		| (Window & {
				setBoidExcitement?: (boidId: string, value: number) => void;
				setClientExcitement?: (clientId: string, value: number) => void;
		  })
		| undefined;

	function clamp01(value: number): number {
		return Math.max(0, Math.min(1, value));
	}

	function initBoids(width: number, height: number): Boid[] {
		return Array.from({ length: BOID_COUNT }, (_, index) => {
			const angle = Math.random() * Math.PI * 2;
			const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
			return {
				id: `boid-${index}`,
				x: Math.random() * width,
				y: Math.random() * height,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				excitability: EXCITABILITY_MIN + Math.random() * (EXCITABILITY_MAX - EXCITABILITY_MIN),
				excitement: 0,
				targetExcitement: 0
			};
		});
	}

	function setBoidExcitement(boidId: string, value: number): void {
		const boid = boids.find((candidate) => candidate.id === boidId);
		if (!boid) return;
		boid.targetExcitement = clamp01(value);
	}

	function assignClientToBoid(clientId: string): string | undefined {
		const existingController = controllers.get(clientId);
		if (existingController) {
			return existingController.boidId;
		}

		const claimedBoidIds = new Set(Array.from(controllers.values(), (controller) => controller.boidId));
		const availableBoid = boids.find((candidate) => !claimedBoidIds.has(candidate.id));
		if (!availableBoid) return undefined;

		controllers.set(clientId, {
			clientId,
			boidId: availableBoid.id,
			lastSeen: performance.now()
		});
		return availableBoid.id;
	}

	function releaseClientBoid(clientId: string): void {
		const controller = controllers.get(clientId);
		if (!controller) return;
		setBoidExcitement(controller.boidId, 0);
		controllers.delete(clientId);
	}

	function getBoidForClient(clientId: string): Boid | undefined {
		const controller = controllers.get(clientId);
		if (!controller) return undefined;
		return boids.find((candidate) => candidate.id === controller.boidId);
	}

	function setClientExcitement(clientId: string, value: number): void {
		const boidId = assignClientToBoid(clientId);
		if (!boidId) return;

		const controller = controllers.get(clientId);
		if (controller) {
			controller.lastSeen = performance.now();
		}

		setBoidExcitement(boidId, value);
	}

	function releaseStaleControllers(now: number): void {
		for (const [clientId, controller] of controllers) {
			if (now - controller.lastSeen > CONTROLLER_TIMEOUT_MS) {
				releaseClientBoid(clientId);
			}
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

				// Toroidal shortest-path delta
				if (dx > w / 2) dx -= w;
				else if (dx < -w / 2) dx += w;
				if (dy > h / 2) dy -= h;
				else if (dy < -h / 2) dy += h;

				const dist = Math.sqrt(dx * dx + dy * dy);

				if (dist < SEP_RADIUS && dist > 0) {
					sepX -= dx / dist;
					sepY -= dy / dist;
					sepCount++;
				}
				if (dist < ALI_RADIUS) {
					aliX += n.vx;
					aliY += n.vy;
					aliCount++;
				}
				if (dist < COH_RADIUS) {
					cohX += n.x;
					cohY += n.y;
					cohCount++;
				}
			}

			let steerX = 0, steerY = 0;

			if (sepCount > 0) {
				const mag = Math.sqrt(sepX * sepX + sepY * sepY);
				if (mag > 0) {
					steerX += (sepX / mag) * steerForce * separationWeight;
					steerY += (sepY / mag) * steerForce * separationWeight;
				}
			}

			if (aliCount > 0) {
				const ax = aliX / aliCount - b.vx;
				const ay = aliY / aliCount - b.vy;
				const mag = Math.sqrt(ax * ax + ay * ay);
				if (mag > 0) {
					steerX += (ax / mag) * steerForce * ALI_WEIGHT;
					steerY += (ay / mag) * steerForce * ALI_WEIGHT;
				}
			}

			if (cohCount > 0) {
				const cx = cohX / cohCount - b.x;
				const cy = cohY / cohCount - b.y;
				const mag = Math.sqrt(cx * cx + cy * cy);
				if (mag > 0) {
					steerX += (cx / mag) * steerForce * COH_WEIGHT;
					steerY += (cy / mag) * steerForce * COH_WEIGHT;
				}
			}

			if (excitement > 0.03) {
				steerX += (Math.random() * 2 - 1) * EXCITE_JITTER_FORCE * excitement;
				steerY += (Math.random() * 2 - 1) * EXCITE_JITTER_FORCE * excitement;
			}

			b.vx += steerX;
			b.vy += steerY;

			const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
			if (speed > maxSpeed) {
				b.vx = (b.vx / speed) * maxSpeed;
				b.vy = (b.vy / speed) * maxSpeed;
			} else if (speed < minSpeed && speed > 0) {
				b.vx = (b.vx / speed) * minSpeed;
				b.vy = (b.vy / speed) * minSpeed;
			}

			b.x += b.vx;
			b.y += b.vy;

			b.x = ((b.x % w) + w) % w;
			b.y = ((b.y % h) + h) % h;
		}
	}

	function drawBoid(ctx: CanvasRenderingContext2D, b: Boid) {
		const excitement = b.excitement;
		const sizeScale = 1 + excitement * 0.3;
		const fillAlpha = 0.85 + excitement * 0.12;
		const strokeAlpha = 0.5 + excitement * 0.35;

		ctx.save();
		ctx.translate(b.x, b.y);
		ctx.rotate(Math.atan2(b.vy, b.vx));
		ctx.scale(sizeScale, sizeScale);
		ctx.beginPath();
		ctx.moveTo(TRI_LENGTH, 0);
		ctx.lineTo(0, TRI_HALF_BASE);
		ctx.lineTo(0, -TRI_HALF_BASE);
		ctx.closePath();
		ctx.fillStyle = `rgba(99, 210, 255, ${fillAlpha})`;
		ctx.strokeStyle = `rgba(210, 248, 255, ${strokeAlpha})`;
		ctx.lineWidth = 0.8 + excitement * 0.8;
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	function loop(now: number) {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		ctx.fillStyle = 'rgba(10, 10, 15, 0.25)';
		ctx.fillRect(0, 0, w, h);

		releaseStaleControllers(now);
		updateBoids();
		for (const b of boids) drawBoid(ctx, b);

		rafId = requestAnimationFrame(loop);
	}

	onMount(() => {
		boidExcitementApi = window as Window & {
			setBoidExcitement?: (boidId: string, value: number) => void;
			setClientExcitement?: (clientId: string, value: number) => void;
		};
		boidExcitementApi.setBoidExcitement = setBoidExcitement;
		boidExcitementApi.setClientExcitement = setClientExcitement;

		const handleResize = () => {
			w = window.innerWidth;
			h = window.innerHeight;
			if (canvasEl) {
				canvasEl.width = w;
				canvasEl.height = h;
			}
		};

		handleResize();
		boids = initBoids(w, h);
		window.addEventListener('resize', handleResize);
		rafId = requestAnimationFrame(loop);

		return () => {
			if (boidExcitementApi) {
				delete boidExcitementApi.setBoidExcitement;
				delete boidExcitementApi.setClientExcitement;
			}
			controllers.clear();
			window.removeEventListener('resize', handleResize);
			cancelAnimationFrame(rafId);
		};
	});
</script>

<div class="fixed inset-0 bg-[#0a0a0f]">
	<canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
</div>
