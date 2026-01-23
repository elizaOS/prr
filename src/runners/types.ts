export interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface Runner {
  name: string;
  run(workdir: string, prompt: string): Promise<RunnerResult>;
  isAvailable(): Promise<boolean>;
}
