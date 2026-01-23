export interface RunnerResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface RunnerOptions {
  model?: string;
}

export interface RunnerStatus {
  installed: boolean;
  ready: boolean;        // Logged in, configured, etc.
  version?: string;
  error?: string;        // Why it's not ready
}

export interface Runner {
  name: string;
  displayName: string;   // Human-friendly name
  run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult>;
  isAvailable(): Promise<boolean>;
  checkStatus(): Promise<RunnerStatus>;
}
