// Parseo y normalización de combinaciones de teclas. Puro y sin dependencias de
// los ajustes: lo usan tanto `settings.ts` (al validar lo guardado) como
// `hotkeys.ts` (al escuchar el teclado). Nada de F1..F12: se retiraron.

export interface Combo {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Tecla normalizada: 'A', '1', 'ArrowLeft', 'Space', ... */
  key: string;
}

export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';

const MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];
const MODIFIER_LABEL: Record<Modifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  // Etiqueta en inglés: es la forma canónica que se guarda y se compara. La
  // interfaz la traduce a «Mayús» al explicarla, pero el valor no lleva acentos.
  shift: 'Shift',
  meta: 'Meta',
};

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  mayus: 'shift',
  'mayús': 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
};

/** Nombres de `KeyboardEvent.key` que se aceptan, en minúsculas. */
const NAMED_KEYS = new Set([
  'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end',
  'pageup', 'pagedown', 'space', 'enter', 'tab', 'escape', 'insert',
  'delete', 'backspace', 'minus', 'equal', 'bracketleft', 'bracketright',
  'backslash', 'semicolon', 'quote', 'comma', 'period', 'slash', 'backquote',
]);

const NAMED_LABEL: Record<string, string> = {
  arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: 'Space',
  enter: 'Enter', tab: 'Tab', escape: 'Escape', insert: 'Insert', delete: 'Delete',
  backspace: 'Backspace', minus: 'Minus', equal: 'Equal', bracketleft: 'BracketLeft',
  bracketright: 'BracketRight', backslash: 'Backslash', semicolon: 'Semicolon',
  quote: 'Quote', comma: 'Comma', period: 'Period', slash: 'Slash', backquote: 'Backquote',
};

/**
 * Atajos del navegador o del sistema. La extensión no los captura nunca, así
 * que tampoco se pueden asignar: el usuario perdería el navegador, no ganaría
 * un atajo.
 */
export const RESERVED_COMBOS: readonly string[] = [
  'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+N', 'Ctrl+Shift+N',
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+L', 'Ctrl+R', 'Ctrl+Shift+R', 'Ctrl+F',
  'Ctrl+Shift+F', 'Ctrl+P', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+Shift+O',
  'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+C', 'Ctrl+Shift+K', 'Ctrl+Shift+E',
  'Ctrl+Shift+M', 'Ctrl+Shift+P', 'Ctrl+Shift+Delete', 'Ctrl+Equal', 'Ctrl+Minus',
  'Ctrl+0', 'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6', 'Ctrl+7',
  'Ctrl+8', 'Ctrl+9', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Tab', 'Alt+F4', 'Alt+Space',
  // Atajos comunes que el navegador se queda para sí (marcador, historial,
  // descargas, código fuente, barra de marcadores...). Asignarlos solo serviría
  // para perder la función del navegador.
  'Ctrl+D', 'Ctrl+H', 'Ctrl+J', 'Ctrl+U', 'Ctrl+Shift+B', 'Ctrl+Shift+D',
  'Alt+Home', 'Alt+D', 'Alt+E', 'Alt+F',
  'Meta+Space', 'Meta+Tab', 'Meta+ArrowLeft', 'Meta+ArrowRight', 'Meta+ArrowUp', 'Meta+ArrowDown',
  'Meta+L', 'Meta+Q', 'Meta+W', 'F5', 'F11', 'F12',
];

const RESERVED = new Set(RESERVED_COMBOS.map((combo) => normalizeComboUnchecked(combo)));

/**
 * Nombre canónico de una tecla, o null si no se reconoce.
 *
 * Acepta tanto `KeyboardEvent.key` (`'a'`, `'ArrowLeft'`, `' '`) como
 * `KeyboardEvent.code` (`'KeyA'`, `'Digit1'`, ...): el atajo se guarda siempre
 * igual, se pulse donde se pulse. La diferencia entre los dos se resuelve en
 * `keyFromCode` / `labelFromKey`.
 */
export function keyLabel(token: string): string | null {
  const lower = token.toLowerCase();
  if (NAMED_KEYS.has(lower)) return NAMED_LABEL[lower]!;
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  if (/^[0-9]$/.test(lower)) return lower;
  // `KeyboardEvent.key` para la barra espaciadora es un espacio literal.
  if (token === ' ') return NAMED_LABEL.space!;
  return null;
}

const CODE_KEYS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (let digit = 0; digit <= 9; digit++) {
    map[`Digit${digit}`] = String(digit);
    map[`Numpad${digit}`] = String(digit);
  }
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    map[`Key${letter}`] = letter;
  }
  for (const name of [
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp',
    'PageDown', 'Space', 'Enter', 'Tab', 'Escape', 'Insert', 'Delete', 'Backspace',
    'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon',
    'Quote', 'Comma', 'Period', 'Slash', 'Backquote',
  ]) {
    map[name] = name;
  }
  return map;
})();

/**
 * Tecla canónica a partir de `KeyboardEvent.code` (posición física de la tecla).
 *
 * Es la fuente de verdad al escuchar: `event.key` depende de la distribución y
 * de los modificadores (Alt+Shift+1 produce `'!'` en un teclado español o
 * inglés, y `'1'` en uno AZERTY), así que un atajo guardado como `Alt+Shift+1`
 * no dispararía nunca si se comparara con `event.key`. Con `code` la tecla es
 * la misma en todas las distribuciones.
 */
export function keyFromCode(code: unknown): string | null {
  if (typeof code !== 'string' || !code) return null;
  return CODE_KEYS[code] ?? null;
}

function toCombo(parts: string[]): Combo | null {
  const combo: Combo = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  let keyToken: string | null = null;
  for (const part of parts) {
    const text = part.trim();
    if (!text) return null;
    const modifier = MODIFIER_ALIASES[text.toLowerCase()];
    if (modifier) {
      if (combo[modifier]) return null;
      combo[modifier] = true;
      continue;
    }
    if (keyToken !== null) return null;
    keyToken = text;
  }
  if (keyToken === null) return null;
  if (MODIFIER_ALIASES[keyToken.toLowerCase()]) return null;
  const key = keyLabel(keyToken);
  if (!key) return null;
  combo.key = key;
  return combo;
}

/** Forma canónica de una combinación ya válida: `Ctrl+Alt+Shift+Meta+Key`. */
export function formatCombo(combo: Combo): string {
  const parts: string[] = [];
  for (const modifier of MODIFIER_ORDER) if (combo[modifier]) parts.push(MODIFIER_LABEL[modifier]);
  parts.push(combo.key);
  return parts.join('+');
}

/**
 * Un atajo necesita Alt, Ctrl o Meta: solo Mayús no basta (Mayús+1 es «!», no
 * un atajo) y una tecla suelta menos todavía.
 */
export function hasCommandModifier(combo: Pick<Combo, Modifier>): boolean {
  return combo.ctrl || combo.alt || combo.meta;
}

/** `Alt+Shift+1` -> `{alt:true, shift:true, ctrl:false, meta:false, key:'1'}`. Null si no vale. */
export function parseCombo(input: string): Combo | null {
  if (typeof input !== 'string') return null;
  const combo = toCombo(input.split('+'));
  if (!combo || !hasCommandModifier(combo)) return null;
  return combo;
}

function normalizeComboUnchecked(input: string): string {
  const combo = toCombo(input.split('+'));
  return combo ? formatCombo(combo).toLowerCase() : '';
}

/**
 * Combo legible y canónico, o null. Rechaza las teclas de función: F1..F12 se
 * retiraron de la extensión y no se pueden volver a asignar.
 */
export function normalizeCombo(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const combo = parseCombo(input);
  if (!combo) return null;
  if (/^F(?:[1-9]|1[0-2])$/.test(combo.key)) return null;
  return formatCombo(combo);
}

export function isReservedCombo(combo: string): boolean {
  return RESERVED.has(combo.toLowerCase());
}
