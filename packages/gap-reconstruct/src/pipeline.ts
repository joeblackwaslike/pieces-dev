export type PipelineOptions = {
  from: Date;
  to: Date;
  sources: string[];
  dryRun: boolean;
  limit?: number;
  concurrency: number;
  skipSummaries: boolean;
  repos?: string[];
};

export async function runPipeline(options: PipelineOptions): Promise<void> {
  console.log(`Gap window: ${options.from.toISOString()} → ${options.to.toISOString()}`);
  console.log(`Sources: ${options.sources.join(', ')}`);
  console.log(`Dry run: ${options.dryRun}`);
  console.log('Pipeline not yet implemented — source tasks follow.');
}
