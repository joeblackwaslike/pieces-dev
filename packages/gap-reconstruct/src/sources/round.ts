/**
 * Round a timestamp to the nearest 5 seconds. Sources use this to build stable
 * dedup keys so the same activity observed by two sources collapses to one
 * event. Shared here so the four sources cannot drift on the bucket size.
 */
export function roundTo5s(date: Date): number {
	return Math.round(date.getTime() / 5000) * 5000;
}
