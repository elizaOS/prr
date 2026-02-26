// Added at the top of the file with other interfaces/types
interface PushIterationResult {
  shouldBreak: boolean;
  committedThisIteration?: boolean;
  exitReason?: string;
  exitDetails?: string;
  updatedRapidFailureCount: number;
  updatedLastFailureTime: number | null;
  updatedConsecutiveFailures: number;
  updatedModelFailuresInCycle: number;
  updatedProgressThisCycle: boolean;
}
