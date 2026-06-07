<script lang="ts">
	import { onMount } from 'svelte';

	type Boid = { x: number; y: number; vx: number; vy: number };

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

	let canvasEl = $state<HTMLCanvasElement | undefined>();

	let boids: Boid[] = [];
	let rafId: number;
	let w = 0;
	let h = 0;

	function initBoids(width: number, height: number): Boid[] {
		return Array.from({ length: BOID_COUNT }, () => {
			const angle = Math.random() * Math.PI * 2;
			const speed = MIN_SPEED + Math.random() * (MAX_SPEED - MIN_SPEED);
			return {
				x: Math.random() * width,
				y: Math.random() * height,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed
			};
		});
	}

	function updateBoids() {
		for (const b of boids) {
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
					steerX += (sepX / mag) * STEER_FORCE * SEP_WEIGHT;
					steerY += (sepY / mag) * STEER_FORCE * SEP_WEIGHT;
				}
			}

			if (aliCount > 0) {
				const ax = aliX / aliCount - b.vx;
				const ay = aliY / aliCount - b.vy;
				const mag = Math.sqrt(ax * ax + ay * ay);
				if (mag > 0) {
					steerX += (ax / mag) * STEER_FORCE * ALI_WEIGHT;
					steerY += (ay / mag) * STEER_FORCE * ALI_WEIGHT;
				}
			}

			if (cohCount > 0) {
				const cx = cohX / cohCount - b.x;
				const cy = cohY / cohCount - b.y;
				const mag = Math.sqrt(cx * cx + cy * cy);
				if (mag > 0) {
					steerX += (cx / mag) * STEER_FORCE * COH_WEIGHT;
					steerY += (cy / mag) * STEER_FORCE * COH_WEIGHT;
				}
			}

			b.vx += steerX;
			b.vy += steerY;

			const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
			if (speed > MAX_SPEED) {
				b.vx = (b.vx / speed) * MAX_SPEED;
				b.vy = (b.vy / speed) * MAX_SPEED;
			} else if (speed < MIN_SPEED && speed > 0) {
				b.vx = (b.vx / speed) * MIN_SPEED;
				b.vy = (b.vy / speed) * MIN_SPEED;
			}

			b.x += b.vx;
			b.y += b.vy;

			b.x = ((b.x % w) + w) % w;
			b.y = ((b.y % h) + h) % h;
		}
	}

	function drawBoid(ctx: CanvasRenderingContext2D, b: Boid) {
		ctx.save();
		ctx.translate(b.x, b.y);
		ctx.rotate(Math.atan2(b.vy, b.vx));
		ctx.beginPath();
		ctx.moveTo(TRI_LENGTH, 0);
		ctx.lineTo(0, TRI_HALF_BASE);
		ctx.lineTo(0, -TRI_HALF_BASE);
		ctx.closePath();
		ctx.fillStyle = 'rgba(99, 210, 255, 0.85)';
		ctx.strokeStyle = 'rgba(180, 240, 255, 0.5)';
		ctx.lineWidth = 0.8;
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	function loop() {
		if (!canvasEl) return;
		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		ctx.fillStyle = 'rgba(10, 10, 15, 0.25)';
		ctx.fillRect(0, 0, w, h);

		updateBoids();
		for (const b of boids) drawBoid(ctx, b);

		rafId = requestAnimationFrame(loop);
	}

	onMount(() => {
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
			window.removeEventListener('resize', handleResize);
			cancelAnimationFrame(rafId);
		};
	});
</script>

<div class="fixed inset-0 bg-[#0a0a0f]">
	<canvas bind:this={canvasEl} class="block h-full w-full"></canvas>
</div>
