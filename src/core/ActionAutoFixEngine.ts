import type { ExecutionResult } from '../types/index.js';
import { applyDeterministicFixes } from './action-autofix/deterministic.js';
import { resolveActionAutoFixConfig } from './action-autofix/constants.js';
import { repairCodeWithModel } from './action-autofix/model-repair.js';
import type { Session } from './Session.js';

export interface ActionAutoFixInput {
  originalCode: string;
  initialResult: ExecutionResult;
  env: Record<string, string>;
  onStderr?: (data: string) => void;
}

export interface ActionAutoFixOutcome {
  result: ExecutionResult;
  code: string;
  summaryLines: string[];
}

export interface ActionAutoFixDependencies {
  repairWithModel?: typeof repairCodeWithModel;
}

export class ActionAutoFixEngine {
  private readonly deps: ActionAutoFixDependencies;

  constructor(
    private readonly session: Session,
    deps?: ActionAutoFixDependencies
  ) {
    this.deps = deps || {};
  }

  async repairAndRetry(input: ActionAutoFixInput): Promise<ActionAutoFixOutcome> {
    const config = resolveActionAutoFixConfig(this.session.agent.config.actionAutoFix);
    const summaryLines: string[] = [];

    if (!config.enabled || !this.isLocalSandbox() || config.maxAttempts <= 0) {
      return { result: input.initialResult, code: input.originalCode, summaryLines };
    }

    let currentCode = input.originalCode;
    let currentResult = input.initialResult;
    let attemptsUsed = 0;
    const installedPackages = new Set<string>();

    if (config.deterministic.enabled && attemptsUsed < config.maxAttempts) {
      attemptsUsed++;
      const deterministic = applyDeterministicFixes({
        code: currentCode,
        errorText: this.buildFailureText(currentResult),
        installedPackages,
      });

      const notes = [...deterministic.notes];
      let installAttempted = false;

      if (deterministic.packageToInstall && config.deterministic.autoInstallMissingPackages) {
        installAttempted = true;
        const packageName = deterministic.packageToInstall;
        installedPackages.add(packageName);

        const installResult = await this.installPackage(packageName, input.onStderr);
        if (installResult.success) {
          notes.push(`installed package "${packageName}"`);
        } else {
          notes.push(`failed to install package "${packageName}"`);
        }
      }

      const codeChanged = deterministic.code !== currentCode;
      if (codeChanged) {
        currentCode = deterministic.code;
      }

      const canRerun = codeChanged || installAttempted;
      if (canRerun) {
        currentResult = await this.session.sandbox.execute(currentCode, undefined, input.env, input.onStderr);
      }

      this.addSummary(
        summaryLines,
        config.visibility,
        `AUTO-FIX: attempt ${attemptsUsed}/${config.maxAttempts} deterministic: ${notes.length > 0 ? notes.join(', ') : 'no applicable fix'}`
      );

      if (currentResult.success) {
        this.addSummary(summaryLines, config.visibility, `AUTO-FIX: succeeded on attempt ${attemptsUsed}`);
        return { result: currentResult, code: currentCode, summaryLines };
      }
    }

    if (config.modelRepair.enabled && attemptsUsed < config.maxAttempts) {
      const modelRepairEligibility = this.canUseModelRepair(this.buildFailureText(currentResult));
      if (!modelRepairEligibility.allowed) {
        this.addSummary(
          summaryLines,
          config.visibility,
          `AUTO-FIX: model repair skipped (${modelRepairEligibility.reason})`
        );
      } else {
        attemptsUsed++;
        const modelRepair = this.deps.repairWithModel || repairCodeWithModel;
        this.addSummary(
          summaryLines,
          config.visibility,
          `AUTO-FIX: attempt ${attemptsUsed}/${config.maxAttempts} model-repair via ${config.modelRepair.provider}/${config.modelRepair.model}`
        );

        const toolDocs = this.buildToolDocs();
        const repairResult = await modelRepair({
          code: currentCode,
          errorText: this.buildFailureText(currentResult),
          provider: config.modelRepair.provider,
          model: config.modelRepair.model,
          temperature: config.modelRepair.temperature,
          maxTokens: config.modelRepair.maxTokens,
          toolDocs,
        });

        if (!repairResult.repairedCode) {
          this.addSummary(summaryLines, config.visibility, `AUTO-FIX: model repair skipped (${repairResult.note})`);
        } else {
          currentCode = repairResult.repairedCode;
          currentResult = await this.session.sandbox.execute(currentCode, undefined, input.env, input.onStderr);
          this.addSummary(summaryLines, config.visibility, `AUTO-FIX: ${repairResult.note}`);

          if (currentResult.success) {
            this.addSummary(summaryLines, config.visibility, `AUTO-FIX: succeeded on attempt ${attemptsUsed}`);
            return { result: currentResult, code: currentCode, summaryLines };
          }
        }
      }
    }

    this.addSummary(summaryLines, config.visibility, `AUTO-FIX: failed after ${attemptsUsed} attempts`);
    return { result: currentResult, code: currentCode, summaryLines };
  }

  private async installPackage(pkg: string, onStderr?: (data: string) => void): Promise<ExecutionResult> {
    const onStdout = (data: string) => process.stdout.write(data);
    const stderr = onStderr || ((data: string) => process.stderr.write(data));
    return this.session.sandbox.executeCli(`npm i ${pkg} --no-audit --no-fund`, onStdout, stderr);
  }

  private buildFailureText(result: ExecutionResult): string {
    return [result.error || '', result.output || ''].filter(Boolean).join('\n').trim();
  }

  private buildToolDocs(): string | undefined {
    const tools = this.session.tools;
    if (!tools || tools.length === 0) return undefined;
    const lines: string[] = [];
    for (const tool of tools) {
      const desc = tool.config.description?.trim();
      if (desc) {
        lines.push(`--- ${tool.config.name} ---`);
        lines.push(desc);
        lines.push('');
      }
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private isLocalSandbox(): boolean {
    const sandboxType = (this.session.agent.config.sandbox || 'local').toLowerCase();
    return sandboxType !== 'browser';
  }

  private addSummary(lines: string[], visibility: 'brief' | 'silent' | 'verbose', message: string): void {
    if (visibility === 'silent') return;
    lines.push(message);
  }

  private canUseModelRepair(errorText: string): { allowed: boolean; reason: string } {
    const normalizedError = (errorText || '').trim();
    if (!normalizedError) {
      return { allowed: false, reason: 'empty error output' };
    }

    if (/No response choices returned from OpenRouter/i.test(normalizedError)) {
      return { allowed: false, reason: 'provider returned empty response (not a code issue)' };
    }

    // Model repair is a cheap last resort after deterministic fixes fail.
    // Attempt it for all code-level errors — including runtime type errors, tool
    // misuse, missing identifiers, and non-syntax issues — since the LLM can
    // often spot what went wrong and generate a corrected version.
    return { allowed: true, reason: 'attempting model repair' };
  }
}

export default ActionAutoFixEngine;
