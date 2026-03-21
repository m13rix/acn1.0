const RESERVED_IDENTIFIERS = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete',
  'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if',
  'import', 'in', 'instanceof', 'new', 'null', 'return', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'await', 'let',
  'static', 'implements', 'package', 'protected', 'interface', 'private', 'public',
]);

const CYRILLIC_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function transliterate(text: string): string {
  return Array.from(text).map((char) => {
    const lower = char.toLowerCase();
    const mapped = CYRILLIC_MAP[lower];
    if (!mapped) return char;
    return char === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
  }).join('');
}

function toWords(input: string): string[] {
  return transliterate(input)
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function upperFirst(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

export function toSafeIdentifier(input: string, fallback = 'importedTool'): string {
  const words = toWords(input);
  if (words.length === 0) return fallback;
  const first = words[0] ?? fallback;
  const rest = words.slice(1);
  let identifier = first.toLowerCase() + rest.map((word) => upperFirst(word.toLowerCase())).join('');
  if (!/^[A-Za-z_$]/.test(identifier)) {
    identifier = `tool${upperFirst(identifier)}`;
  }
  if (RESERVED_IDENTIFIERS.has(identifier)) {
    identifier = `${identifier}Tool`;
  }
  return identifier || fallback;
}

export function toSafeSlug(input: string, fallback = 'imported-tool'): string {
  const words = toWords(input);
  const slug = words.map((word) => word.toLowerCase()).join('-');
  return slug || fallback;
}

function stripDuplicatePrefix(rawName: string, namespace: string): string {
  const normalized = rawName.toLowerCase();
  const prefixes = [
    `${namespace.toLowerCase()}_`,
    `${namespace.toLowerCase()}-`,
    `${namespace.toLowerCase()}.`,
    `${namespace.toLowerCase()}:`,
  ];
  for (const prefix of prefixes) {
    if (normalized.startsWith(prefix)) {
      return rawName.slice(prefix.length);
    }
  }
  return rawName;
}

export function deriveNamespace(input: string, existingNames: Iterable<string> = []): string {
  const base = toSafeIdentifier(input);
  const used = new Set(existingNames);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}${Date.now()}`;
}

export function deriveMethodName(rawName: string, namespace: string, existingNames: Iterable<string> = []): string {
  const base = toSafeIdentifier(stripDuplicatePrefix(rawName, namespace) || rawName, 'run');
  const used = new Set(existingNames);
  if (!used.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}${Date.now()}`;
}
