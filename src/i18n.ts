/**
 * The gateway's two languages, as two plain frozen dictionaries.
 *
 * ── WHY NOT i18next, AND WHY NOT A JSON BUNDLE ──────────────────────────────
 * The openplate client uses i18next with per-locale JSON files, and copying
 * that here would be wrong. The console this feeds (`server/admin-ui.ts`) is
 * deliberately ONE file with no build step, no CDN and no network fetch — read
 * its header before changing any of that. A resource loader, an async
 * namespace and a provider would all be machinery for about forty strings, and
 * every one of them is a way for the page to end up fetching something. A
 * `Record` of string literals fetches nothing and needs no runtime.
 *
 * ── A MISSING GERMAN KEY IS A COMPILE ERROR ─────────────────────────────────
 * `GERMAN` is annotated with the shape derived from `ENGLISH`, so a key present
 * in one and absent from the other fails `tsc`, and a key misspelled in German
 * fails as an excess property. There is deliberately NO runtime substitution
 * for an absent key: an operator who switched to German and silently got half
 * an English page would have no way to notice, whereas a build that refuses to
 * compile is impossible to miss. This is the opposite choice from the client's
 * `fallbackLng`, and it is the right one here for the opposite reason — the
 * client's German bundle is 1603 keys maintained by many hands, this is forty
 * maintained in one file.
 *
 * ── PLACEHOLDERS ARE `{name}`, SUBSTITUTED BY `fill` ────────────────────────
 * Not template literals: these strings cross into the browser as data (see
 * `admin-ui.ts`), so they cannot close over anything. `fill` replaces every
 * occurrence and leaves an unknown placeholder alone rather than rendering
 * `undefined`.
 *
 * ── THE GERMAN IS MACHINE-TRANSLATED, THROUGH ONE TOOL ─────────────────────
 * `pnpm -C djinn wordsmith translate` (Gemini 3.7 Flash via OpenRouter) produced
 * it, and that tool VERIFIES its own output before writing: the key sets must
 * match exactly, every `{placeholder}` must survive, and the names in its
 * keep-list must not be translated. A drift in any of those is refused rather
 * than repaired, so a bad run fails loudly instead of landing a plausible
 * bundle with a hole in it.
 *
 * Re-run it, do not hand-edit one string: a hand edit is invisible to the next
 * translation and silently reverts.
 *
 * ── GERMAN TYPOGRAPHY IS DELIBERATE ─────────────────────────────────────────
 * German quotation marks are „…" and the umlauts and ß are written as real
 * characters, not entities. Both survive because every sink escapes properly:
 * the console injects these through `JSON.stringify` into a UTF-8 document, and
 * the mail builder escapes them for HTML. `tests/i18n.test.ts` asserts it,
 * because an escaping mistake of this kind is visible only in the language the
 * person who made it does not read.
 */

export const GATEWAY_LANGUAGES = ['en', 'de'] as const;

export type GatewayLanguage = (typeof GATEWAY_LANGUAGES)[number];

/** Native display names — a language is always named in its own language. */
export const GATEWAY_LANGUAGE_LABELS: Record<GatewayLanguage, string> = {
  en: 'English',
  de: 'Deutsch',
};

export function isGatewayLanguage(value: unknown): value is GatewayLanguage {
  return typeof value === 'string' && (GATEWAY_LANGUAGES as readonly string[]).includes(value);
}

const ENGLISH = {
  console: {
    title: 'Gateway admin',
    heading: 'Gateway admin',
    auditModeLine: 'Organization mode — audit active. Requests and images are recorded.',

    adminTokenLabel: 'Admin token',
    unlock: 'Unlock',
    tokenNote:
      'The token is kept in this page only, for as long as the tab is open. It is not saved in your browser and not put in the address bar. Close the tab to sign out.',
    tokenRejected: 'That token was not accepted. Check it and try again.',
    gatewayUnreachable: 'The gateway could not be reached.',

    membersHeading: 'Members',
    membersEmpty: 'No members yet. Invite somebody below.',
    newMemberIdLabel: 'New member ID',
    createMember: 'Create member',
    memberCreated: 'Member "{id}" created.',
    memberTokenLabel: 'Member token — shown once, and never again.',
    memberTokenNote: 'Give it to them now. It is not stored and cannot be recovered.',
    confirmRevokeMember: 'Revoke member "{id}"? Their token stops working immediately.',

    invitesHeading: 'Invites',
    invitesEmpty: 'No invites yet.',
    memberIdLabel: 'Member ID',
    emailOptionalLabel: 'Email (optional)',
    ttlHoursLabel: 'Valid for, hours (optional)',
    createInvite: 'Create invite',
    inviteCreated: 'Invite for "{id}" created.',
    inviteLinkLabel: 'Invite link — shown once. Send it to the person you are inviting.',
    inviteNoLink:
      'No link could be built: this gateway has no public URLs configured. Send the token below instead.',
    inviteTokenLabel: 'Invite token — shown once, and never again.',
    inviteEmailSent: 'An email was also sent.',
    inviteEmailNotSent: 'No email was sent — share the link yourself.',
    confirmRevokeInvite: 'Revoke the invite for "{id}"? The link stops working.',

    colId: 'ID',
    colDailyLimit: 'Daily limit',
    colCreated: 'Created',
    colRevoked: 'Revoked',
    colMemberId: 'Member ID',
    colStatus: 'Status',
    colExpires: 'Expires',
    colEmail: 'Email',

    // The API returns these as raw enum values (`invite-store.ts`'s
    // `InviteStatus`). Untranslated, a German console shows an English word in
    // its most-read column.
    statusPending: 'Pending',
    statusRedeemed: 'Redeemed',
    statusExpired: 'Expired',
    statusRevoked: 'Revoked',

    revoke: 'Revoke',
    copy: 'Copy',
    copied: 'Copied',
    selectAndCopy: 'Select and copy',
    somethingWentWrong: 'Something went wrong.',
    gatewayAnswered: 'The gateway answered {status}.',
  },

  mail: {
    subject: 'You have been invited to {gateway}',
    invitedTo: 'You have been invited to use {gateway}.',
    whatItIs:
      'It lets you use openplate without setting up your own AI provider key — the person who invited you pays for the requests.',
    openLink: 'Open this link to connect:',
    openLinkHtml: 'Open this link to connect',
    allowance: 'Your allowance: {limit} requests per day.',
    expires: 'This invite expires: {expiry}. It can be used once.',
    privacy:
      'Your food diary stays on your own device. Only the photo you send for an estimate passes through the gateway, and no request is ever logged.',
    unexpected: 'If you were not expecting this, ignore it — nothing happens until the link is opened.',
  },
} as const;

/** The shape both languages must have, derived from English so it cannot drift. */
export type GatewayStrings = {
  console: Record<keyof (typeof ENGLISH)['console'], string>;
  mail: Record<keyof (typeof ENGLISH)['mail'], string>;
};

const GERMAN: GatewayStrings = {
  console: {
    title: 'Gateway-Admin',
    heading: 'Gateway-Admin',
    auditModeLine: 'Organisationsmodus – Protokollierung aktiv. Anfragen und Bilder werden aufgezeichnet.',
    adminTokenLabel: 'Admin-Token',
    unlock: 'Entsperren',
    tokenNote:
      'Das Token wird nur auf dieser Seite gehalten, solange der Tab geöffnet ist. Es wird nicht im Browser gespeichert und nicht in der Adressleiste aufgeführt. Schließen Sie den Tab, um sich abzumelden.',
    tokenRejected: 'Dieses Token wurde nicht akzeptiert. Bitte prüfen Sie es und versuchen Sie es erneut.',
    gatewayUnreachable: 'Das Gateway konnte nicht erreicht werden.',
    membersHeading: 'Mitglieder',
    membersEmpty: 'Noch keine Mitglieder vorhanden. Laden Sie unten jemanden ein.',
    newMemberIdLabel: 'Neue Mitglieds-ID',
    createMember: 'Mitglied anlegen',
    memberCreated: 'Mitglied „{id}“ wurde angelegt.',
    memberTokenLabel: 'Mitglieder-Token – wird nur dieses eine Mal angezeigt.',
    memberTokenNote:
      'Geben Sie es der Person jetzt. Es wird nicht gespeichert und kann nicht wiederhergestellt werden.',
    confirmRevokeMember: 'Mitglied „{id}“ widerrufen? Das Token verliert sofort seine Gültigkeit.',
    invitesHeading: 'Einladungen',
    invitesEmpty: 'Noch keine Einladungen vorhanden.',
    memberIdLabel: 'Mitglieds-ID',
    emailOptionalLabel: 'E-Mail (optional)',
    ttlHoursLabel: 'Gültig für, Stunden (optional)',
    createInvite: 'Einladung erstellen',
    inviteCreated: 'Einladung für „{id}“ wurde erstellt.',
    inviteLinkLabel: 'Einladungslink – wird nur einmal angezeigt. Senden Sie ihn an die eingeladene Person.',
    inviteNoLink:
      'Es konnte kein Link erstellt werden: Für dieses Gateway sind keine öffentlichen URLs eingerichtet. Senden Sie stattdessen das Token unten.',
    inviteTokenLabel: 'Einladungs-Token – wird nur dieses eine Mal angezeigt.',
    inviteEmailSent: 'Eine E-Mail wurde ebenfalls gesendet.',
    inviteEmailNotSent: 'Es wurde keine E-Mail gesendet – teilen Sie den Link selbst.',
    confirmRevokeInvite: 'Einladung für „{id}“ widerrufen? Der Link verliert seine Gültigkeit.',
    colId: 'ID',
    colDailyLimit: 'Tageslimit',
    colCreated: 'Erstellt',
    colRevoked: 'Widerrufen',
    colMemberId: 'Mitglieds-ID',
    colStatus: 'Status',
    colExpires: 'Gültig bis',
    colEmail: 'E-Mail',
    statusPending: 'Ausstehend',
    statusRedeemed: 'Eingelöst',
    statusExpired: 'Abgelaufen',
    statusRevoked: 'Widerrufen',
    revoke: 'Widerrufen',
    copy: 'Kopieren',
    copied: 'Kopiert',
    selectAndCopy: 'Auswählen und kopieren',
    somethingWentWrong: 'Etwas ist schiefgelaufen.',
    gatewayAnswered: 'Das Gateway hat mit {status} geantwortet.',
  },

  mail: {
    subject: 'Sie wurden zu {gateway} eingeladen',
    invitedTo: 'Sie wurden eingeladen, {gateway} zu nutzen.',
    whatItIs:
      'Damit können Sie openplate nutzen, ohne einen eigenen KI-Anbieterschlüssel einzurichten – die Person, die Sie eingeladen hat, übernimmt die Kosten für die Anfragen.',
    openLink: 'Öffnen Sie diesen Link, um sich zu verbinden:',
    openLinkHtml: 'Öffnen Sie diesen Link, um sich zu verbinden',
    allowance: 'Ihr Kontingent: {limit} Anfragen pro Tag.',
    expires: 'Diese Einladung ist gültig bis: {expiry}. Sie kann einmalig verwendet werden.',
    privacy:
      'Ihr Ernährungstagebuch bleibt auf Ihrem eigenen Gerät. Nur das Foto, das Sie für eine Schätzung senden, wird über das Gateway geleitet, und es wird keinerlei Anfrage protokolliert.',
    unexpected:
      'Wenn Sie diese Einladung nicht erwartet haben, können Sie sie einfach ignorieren – es passiert nichts, solange der Link nicht geöffnet wird.',
  },
};

const STRINGS: Record<GatewayLanguage, GatewayStrings> = {
  en: ENGLISH,
  de: GERMAN,
};

/** The dictionary for one language. Total — every key exists in every language. */
export function stringsFor(language: GatewayLanguage): GatewayStrings {
  return STRINGS[language];
}

/**
 * Substitutes `{name}` placeholders.
 *
 * An unknown placeholder is left in place rather than replaced with `undefined`
 * — a visible `{limit}` in an email says "this template is wrong" to whoever
 * reads it, while `undefined` reads as a broken gateway.
 *
 * @param template - a string from a dictionary above.
 * @param values - one entry per placeholder the template uses.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}
