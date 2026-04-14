/**
 * Classify final-audit explanations that passed the adversarial check without
 * a normal FIXED verdict — **WHY:** Operators may want CI to fail closed when
 * the model used UNCERTAIN or we applied the truncation guard (`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`).
 */

export type FinalAuditUncertainKind = 'uncertain' | 'truncation-guard';

export function classifyFinalAuditUncertainExplanation(explanation: string): FinalAuditUncertainKind | null {
  const e = explanation.trim();
  if (!e) return null;
  if (/^FIXED \(truncation guard\):/i.test(e)) return 'truncation-guard';
  if (/^UNCERTAIN \(audit pass\):/i.test(e) || /^UNCERTAIN:/i.test(e)) return 'uncertain';
  return null;
}
