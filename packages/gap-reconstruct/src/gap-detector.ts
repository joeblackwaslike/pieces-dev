export type Gap = {
  from: Date;
  to: Date;
};

export async function detectGaps(
  _since: Date,
  _until: Date,
  _minGapMs: number,
): Promise<Gap[]> {
  console.log('Gap detection not yet implemented — see Task 14.');
  return [];
}
