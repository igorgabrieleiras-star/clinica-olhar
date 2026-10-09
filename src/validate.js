// Validações compartilhadas pelo servidor. O navegador repete as mesmas regras apenas para dar retorno rápido.

export class ValidationError extends Error {
  constructor(field, message, code = 'INVALID') {
    super(message);
    this.field = field;
    this.code = code;
    this.status = 422;
  }
}

const NAME_RE = /^[\p{L}][\p{L}\p{M}'’ .-]*[\p{L}.]$/u;

export function cleanName(raw, field = 'name') {
  const name = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
  const ask = field === 'guardian_name' ? 'Digite o nome do responsável.' : 'Digite seu nome.';
  if (name.length < 2) throw new ValidationError(field, ask);
  if (name.length > 80) throw new ValidationError(field, 'O nome pode ter no máximo 80 caracteres.');
  if (!NAME_RE.test(name)) throw new ValidationError(field, 'Use apenas letras no nome.');
  if ((name.match(/\p{L}/gu) || []).length < 2) throw new ValidationError(field, ask);
  return name;
}

// DDDs válidos no Brasil (Anatel)
export const VALID_DDD = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92,
  93, 94, 95, 96, 97, 98, 99,
]);

/** Retorna somente dígitos (DDD + número). Aceita celulares (11 dígitos) e fixos (10 dígitos). */
export function cleanWhatsapp(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length >= 12 && digits.startsWith('55')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  const invalid = () => new ValidationError('whatsapp', 'Confira o número com DDD. Exemplo: (92) 99999-9999.');
  if (digits.length !== 10 && digits.length !== 11) throw invalid();
  if (!VALID_DDD.has(Number(digits.slice(0, 2)))) throw invalid();
  if (digits.length === 11 && digits[2] !== '9') throw invalid();
  if (/^(\d)\1+$/.test(digits)) throw invalid();
  return digits;
}

export function formatWhatsapp(d) {
  if (!d) return '';
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d;
}

/** Aplica as regras de idade configuradas pela clínica. */
export function cleanAge(raw, rules = {}) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,3}$/.test(s)) throw new ValidationError('age', 'Digite sua idade em anos.');
  const age = Number(s);
  if (age > 120) throw new ValidationError('age', 'Confira a idade digitada.');
  if (rules.min_age !== null && rules.min_age !== undefined && rules.min_age !== '' && age < Number(rules.min_age)) {
    throw new ValidationError('age', `Este atendimento é para pessoas a partir de ${rules.min_age} anos.`, 'AGE_RULE');
  }
  if (rules.max_age !== null && rules.max_age !== undefined && rules.max_age !== '' && age > Number(rules.max_age)) {
    throw new ValidationError('age', `Este atendimento é para pessoas de até ${rules.max_age} anos.`, 'AGE_RULE');
  }
  if (age < 18 && rules.minor_rule === 'blocked') {
    throw new ValidationError('age', 'Este atendimento é exclusivo para maiores de 18 anos.', 'AGE_RULE');
  }
  return age;
}

export function cleanTime(raw) {
  const s = String(raw ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new ValidationError('time', 'Escolha um horário.');
  return s;
}

/** Texto curto opcional (UTMs, referrer). Remove caracteres de controle e limita o tamanho. */
export function optText(raw, max = 200) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return s || null;
}

export function isUuid(s) {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}
