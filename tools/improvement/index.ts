import {
  getSelfImproverStateService,
  type ImprovementAlignmentAssessmentInput,
  type ImprovementAuditInput,
  type ImprovementInitiativeInput,
  type ImprovementInitiativePatch,
  type ImprovementInsightInput,
} from '../../src/services/self-improver/StateService.js';

const service = getSelfImproverStateService();

export async function getState(recentAuditLimit?: number) {
  return service.getState(recentAuditLimit);
}

export async function saveInsight(input: ImprovementInsightInput) {
  return service.saveInsight(input);
}

export async function proposeInitiative(input: ImprovementInitiativeInput) {
  return service.proposeInitiative(input);
}

export async function updateInitiative(id: string, patch: ImprovementInitiativePatch) {
  return service.updateInitiative(id, patch);
}

export async function recordAudit(input: ImprovementAuditInput) {
  return service.recordAudit(input);
}

export async function recordAlignmentAssessment(input: ImprovementAlignmentAssessmentInput) {
  return service.recordAlignmentAssessment(input);
}
