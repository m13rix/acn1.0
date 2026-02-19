export interface ActionErrorClassification {
  raw: string;
  missingIdentifier?: string;
  missingPackage?: string;
  hasSyntaxError: boolean;
  hasUnterminatedString: boolean;
  hasUnexpectedEnd: boolean;
}

const MISSING_IDENTIFIER_PATTERNS: RegExp[] = [
  /ReferenceError:\s*([A-Za-z_$][\w$]*)\s+is not defined/i,
  /TS2304:\s*Cannot find name ['"]?([A-Za-z_$][\w$]*)['"]?/i,
  /Cannot find name ['"]?([A-Za-z_$][\w$]*)['"]?/i,
];

const MISSING_PACKAGE_PATTERNS: RegExp[] = [
  /Cannot find module ['"]([^'"]+)['"]/i,
  /Cannot find package ['"]([^'"]+)['"]/i,
  /TS2307:\s*Cannot find module ['"]([^'"]+)['"]/i,
];

const SYNTAX_PATTERNS: RegExp[] = [
  /\bSyntaxError\b/i,
  /\bTS1002\b/i,
  /\bTS1003\b/i,
  /\bTS1005\b/i,
  /\bTS1109\b/i,
  /\bTS1128\b/i,
  /\bTS1160\b/i,
  /Unexpected token/i,
  /Unexpected end of input/i,
  /Unexpected EOF/i,
  /Unterminated/i,
];

const UNTERMINATED_STRING_PATTERNS: RegExp[] = [
  /Unterminated string/i,
  /Unterminated template literal/i,
  /TS1002/i,
  /TS1160/i,
];

const UNEXPECTED_END_PATTERNS: RegExp[] = [
  /Unexpected end of input/i,
  /Unexpected EOF/i,
  /['"`)\]}]\s+expected/i,
];

export function classifyActionError(errorText: string): ActionErrorClassification {
  const raw = errorText || '';

  return {
    raw,
    missingIdentifier: findFirstMatch(raw, MISSING_IDENTIFIER_PATTERNS),
    missingPackage: findFirstMatch(raw, MISSING_PACKAGE_PATTERNS),
    hasSyntaxError: SYNTAX_PATTERNS.some((pattern) => pattern.test(raw)),
    hasUnterminatedString: UNTERMINATED_STRING_PATTERNS.some((pattern) => pattern.test(raw)),
    hasUnexpectedEnd: UNEXPECTED_END_PATTERNS.some((pattern) => pattern.test(raw)),
  };
}

function findFirstMatch(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}
