export type Landmark = { x: number; y: number; z: number };

export function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

export function averageLandmarks(points: Array<Landmark | undefined>): Landmark | undefined {
	let sumX = 0;
	let sumY = 0;
	let sumZ = 0;
	let count = 0;

	for (const point of points) {
		if (!point) continue;
		sumX += point.x;
		sumY += point.y;
		sumZ += point.z;
		count += 1;
	}

	if (count === 0) return undefined;

	return {
		x: sumX / count,
		y: sumY / count,
		z: sumZ / count
	};
}

function distance2d(a: Landmark | undefined, b: Landmark | undefined): number {
	if (!a || !b) return 0;
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function computeBodyReference(poseLandmarks: Landmark[]) {
	const shoulderCenter = averageLandmarks([poseLandmarks[11], poseLandmarks[12]]);
	const hipCenter = averageLandmarks([poseLandmarks[23], poseLandmarks[24]]);

	if (!shoulderCenter || !hipCenter) return undefined;

	const bodyCenter = averageLandmarks([shoulderCenter, hipCenter]) ?? shoulderCenter;
	const torsoHeight = Math.abs(hipCenter.y - shoulderCenter.y);
	const bodyWidth = Math.max(0.08, distance2d(poseLandmarks[11], poseLandmarks[12]));

	return {
		shoulderCenter,
		hipCenter,
		bodyCenter,
		torsoHeight,
		bodyWidth
	};
}

export function computeRelativeVerticalPosition(point: Landmark, topY: number, bottomY: number): number {
	return clamp01((bottomY - point.y) / Math.max(0.001, bottomY - topY));
}

export function computeRelativeHorizontalPosition(
	point: Landmark,
	centerX: number,
	width: number
): number {
	const safeWidth = Math.max(0.001, width);
	const leftX = centerX - safeWidth * 1.5;
	const rightX = centerX + safeWidth * 1.5;
	return clamp01((point.x - leftX) / Math.max(0.001, rightX - leftX));
}

export function computeRelativeHandY(wrist: Landmark, poseLandmarks: Landmark[]): number {
	const bodyReference = computeBodyReference(poseLandmarks);
	if (!bodyReference) return clamp01(wrist.y);

	const upperExtension = bodyReference.torsoHeight * 0.75;
	const extendedTopY = bodyReference.shoulderCenter.y - upperExtension;

	return computeRelativeVerticalPosition(wrist, extendedTopY, bodyReference.hipCenter.y);
}

export function computeRelativeHandX(wrist: Landmark, poseLandmarks: Landmark[]): number {
	const bodyReference = computeBodyReference(poseLandmarks);
	if (!bodyReference) return clamp01(wrist.x);

	return computeRelativeHorizontalPosition(
		wrist,
		bodyReference.bodyCenter.x,
		bodyReference.bodyWidth
	);
}
