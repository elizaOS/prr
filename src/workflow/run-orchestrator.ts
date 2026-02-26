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
 
 // CLI convention: 0 = unlimited. Use ?? so explicit 0 is honored.
const maxPushIterations = options.autoPush ? (options.maxPushIterations ?? Infinity) : 1;
