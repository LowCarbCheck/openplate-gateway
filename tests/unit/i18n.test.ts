/**
 * The gateway's two dictionaries (M167/03).
 *
 * Key-set equality is enforced by `tsc` (`GERMAN` is annotated with the shape
 * derived from `ENGLISH`), and that was proved by removing a German key and
 * watching the build fail. These tests cover what the type system CANNOT see:
 *
 *  - a German entry that was copied from English and never translated;
 *  - a placeholder that survives in one language and was dropped in the other,
 *    which produces a sentence missing its number rather than a type error;
 *  - `fill`'s behaviour on a placeholder nobody supplied.
 *
 * The last two matter because both failures render a plausible-looking string.
 * Nothing throws, nothing logs, and the mistake is visible only to a reader of
 * the language that broke.
 */
import { describe, it, expect } from 'vitest';

import { GATEWAY_LANGUAGES, fill, isGatewayLanguage, stringsFor } from '../../src/i18n.js';

const EN = stringsFor('en');
const DE = stringsFor('de');

/** Every `{name}` a template uses, as a sorted list. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).toSorted();
}

type Section = 'console' | 'mail';
const SECTIONS: Section[] = ['console', 'mail'];

describe('language vocabulary', () => {
  it('recognises the two shipped codes and nothing else', () => {
    expect(GATEWAY_LANGUAGES).toEqual(['en', 'de']);
    expect(isGatewayLanguage('de')).toBe(true);
    expect(isGatewayLanguage('fr')).toBe(false);
    expect(isGatewayLanguage(undefined)).toBe(false);
    expect(isGatewayLanguage(2)).toBe(false);
  });
});

describe('dictionary parity', () => {
  for (const section of SECTIONS) {
    it(`${section}: the same keys in both directions`, () => {
      // Both directions on purpose. A one-directional check passes when one
      // dictionary is a strict superset of the other.
      expect(Object.keys(DE[section]).toSorted()).toEqual(Object.keys(EN[section]).toSorted());
    });

    it(`${section}: no key is left untranslated`, () => {
      // The failure this catches: a key added to English, pasted into German
      // to make the build pass, and never translated. `tsc` is happy; a German
      // operator reads an English sentence.
      const identical = Object.keys(EN[section]).filter(
        (key) => EN[section][key as never] === DE[section][key as never],
      );
      // An ALLOWLIST, not a threshold: each entry is a word that is genuinely
      // identical in both languages, and adding one is a deliberate act.
      // 'ID' and 'Status' are both ordinary German words spelled the same way.
      expect(identical).toEqual(section === 'console' ? ['colId', 'colStatus'] : []);
    });

    it(`${section}: every placeholder survives translation`, () => {
      for (const key of Object.keys(EN[section])) {
        const en = EN[section][key as never] as string;
        const de = DE[section][key as never] as string;
        expect(placeholders(de), `placeholders drifted in ${section}.${key}`).toEqual(placeholders(en));
      }
    });
  }
});

describe('German typography', () => {
  it('carries real umlauts and eszett, not entities or ASCII substitutes', () => {
    const all = JSON.stringify(DE);
    expect(all).toMatch(/[äöüß]/);
    // `&auml;` and friends would render literally in the console, which builds
    // rows with textContent, and would double-escape in the mail.
    expect(all).not.toMatch(/&[a-z]+;/);
  });

  it('uses German quotation marks where English used straight ones', () => {
    expect(DE.console.memberCreated).toContain('„');
    expect(EN.console.memberCreated).toContain('"');
  });
});

describe('fill', () => {
  it('substitutes every occurrence', () => {
    expect(fill('{a} and {a} and {b}', { a: 'x', b: 'y' })).toBe('x and x and y');
  });

  it('accepts numbers without the caller stringifying them', () => {
    expect(fill(EN.mail.allowance, { limit: 25 })).toContain('25');
    expect(fill(DE.mail.allowance, { limit: 25 })).toContain('25');
  });

  it('leaves an unsupplied placeholder visible rather than printing undefined', () => {
    // A visible `{limit}` says "this template is wrong" to whoever reads it.
    // `undefined` reads as a broken gateway.
    expect(fill('you get {limit} per day', {})).toBe('you get {limit} per day');
  });

  it('does not touch text that merely looks like a placeholder', () => {
    expect(fill('a {not a placeholder} b', { x: '1' })).toBe('a {not a placeholder} b');
  });
});
