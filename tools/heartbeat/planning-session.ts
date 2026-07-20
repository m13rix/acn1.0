export interface PlanningSessionBindingInput {
  decisionId: string;
  instruction: string;
  id?: string;
  temporary?: boolean;
  metadata?: Record<string, unknown>;
}

export function buildPlanningSessionHandler(decisionId: string, instruction: string, temporary: boolean): Function {
  const baseRequest = [
    'TELOS_PLANNING_SESSION v1',
    'MODE: PLANNING',
    `DECISION_ID: ${decisionId}`,
    `INSTRUCTION: ${instruction}`,
    'Recover the decision workspace. Use Executor for all retrieval and action. Preserve future evidence and continuation before ending.',
  ].join('\n');
  const source = `return async function(event, ctx) {
    const request = ${JSON.stringify(baseRequest)} + "\\nTRIGGER_EVENT: " + JSON.stringify({
      sensor: event.sensor,
      event: event.event,
      args: event.args,
      payload: event.payload,
      occurredAt: event.occurredAt,
      bindingId: event.bindingId
    });
    const result = await agents.run("Telos", request);
    if (!result || typeof result.finalMessage !== "string" || result.finalMessage.startsWith("Error")) {
      throw new Error("Planning-session Telos invocation failed: " + JSON.stringify(result));
    }
    if (${temporary ? 'true' : 'false'}) await ctx.unbind();
  }`;
  return new Function(source)();
}
