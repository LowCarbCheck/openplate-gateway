/**
 * The operator's page: everything `admin-routes.ts` exposes, without a terminal.
 *
 * ── WHY A PAGE AT ALL ───────────────────────────────────────────────────────
 * The admin API is complete and the person who has to use it is a parent paying
 * a provider bill, not an engineer. A flow whose first step is "install curl"
 * excludes the majority of the people this gateway is for. This page adds no
 * capability: every button below calls an endpoint that already existed, and
 * there is no route here that is not a `GET` of this document.
 *
 * ── ONE FILE, NO BUILD STEP, NO CDN ─────────────────────────────────────────
 * The markup, the style and the script are one string in this module, so
 * `scripts/build.ts` carries the page into `dist/main.js` with no asset copy and
 * no second artifact to keep in sync. It also means the page loads NOTHING from
 * the network: an admin console that fetches a framework from a CDN hands a
 * third party the ability to run code on the surface that mints member tokens.
 *
 * ── THE PAGE IS SERVED WITHOUT A BEARER; THE PAGE ITSELF IS NOT A CREDENTIAL ─
 * A browser cannot attach an `Authorization` header to a navigation, so this
 * document is served unauthenticated — but it is a locked door, not a room. It
 * renders a token form and nothing else until a token is typed, and it holds
 * exactly zero data of its own. Every fact on screen arrives from an API call
 * that carries the bearer, so an unauthenticated visitor sees an empty form.
 *
 * It is still mounted ONLY when an admin token is configured (see
 * `create-app.ts`), so an operator who never wanted an admin surface does not
 * get a page advertising one — `/admin/ui` 404s exactly like `/admin/members`.
 *
 * ── THE TOKEN LIVES IN A VARIABLE AND NOWHERE ELSE ──────────────────────────
 * Not `localStorage`, not `sessionStorage`, not a cookie, not the URL. This one
 * token can mint members and read the roster, and every one of those stores
 * outlives the tab: a shared family laptop would keep the payer's admin
 * credential readable by the next person to open the console. A cookie would be
 * worse still — it would be attached automatically and make this the CSRF target
 * `create-app.ts` refuses cookies to avoid. Closing the tab is the logout.
 *
 * ── A PER-REQUEST NONCE, NOT `unsafe-inline` ────────────────────────────────
 * A single self-contained file means the script and the style are inline, and
 * the honest way to allow that is a nonce rather than `'unsafe-inline'` — which
 * would allow any injected inline script too. The header is scoped to this route
 * and this route only; the app sets no CSP anywhere else, so nothing is
 * loosened by it.
 */
import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { stringsFor, type GatewayLanguage } from '../i18n.js';

/** The only endpoints the page talks to. All three already existed. */
const MEMBERS_PATH = '/admin/members';
const INVITES_PATH = '/admin/invites';
const GATEWAY_INFO_PATH = '/v1/gateway/info';

/**
 * `default-src 'none'` and then only what this page needs: its own two inline
 * blocks by nonce, and same-origin XHR. No images, no fonts, no frames, and
 * `form-action 'none'` because every form here is submitted by `fetch`.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The page, with the nonce woven into both inline blocks.
 *
 * The script builds every row with `textContent`, never `innerHTML`: a member id
 * is operator-supplied text, and the one place it is displayed must not be the
 * one place it is executed.
 */
/**
 * Escapes a dictionary string on its way into element text.
 *
 * Every string here is a compile-time literal we wrote, so this is not
 * defending against an attacker — it is defending against a translator. German
 * copy is the first place a `&` or a `<` shows up in what used to be plain
 * ASCII, and an unescaped one produces a page that is subtly wrong only in the
 * language the person who shipped it does not read.
 */
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Serialises the dictionary for the inline `<script>`.
 *
 * `JSON.stringify` alone is not enough inside a script element: a literal
 * `</script>` anywhere in a string would close the block early. `<` is escaped
 * to its `\u003c` form, which JSON parses back to the same character, so the
 * strings arrive intact and the document cannot be broken by one.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderAdminUiPage(nonce: string, language: GatewayLanguage): string {
  const t = stringsFor(language).console;
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(t.title)}</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; --line: #d6d8dd; --muted: #5b6068; --bad: #a4262c; --ok: #1f7a4d; }
* { box-sizing: border-box; }
body { margin: 0; padding: 1.5rem 1rem 4rem; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
p { margin: .4rem 0; }
.muted { color: var(--muted); font-size: .875rem; }
.error { color: var(--bad); }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin: .75rem 0; }
form.row { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; }
label { display: block; font-size: .8rem; color: var(--muted); margin-bottom: .15rem; }
input { font: inherit; padding: .4rem .5rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; min-width: 9rem; }
button { font: inherit; padding: .45rem .8rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--muted); }
button:disabled { opacity: .45; cursor: default; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: middle; }
th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; word-break: break-all; }
.secret { display: flex; gap: .5rem; align-items: center; margin: .35rem 0; }
.secret code { flex: 1; padding: .35rem .5rem; border: 1px dashed var(--line); border-radius: 6px; }
.status-pending { color: var(--ok); }
.status-expired, .status-revoked { color: var(--muted); }
[hidden] { display: none !important; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(t.heading)}</h1>
  <p class="muted" id="mode-line" hidden></p>

  <section id="signin" class="card">
    <form class="row" id="signin-form">
      <div>
        <label for="admin-token">${escapeHtml(t.adminTokenLabel)}</label>
        <input id="admin-token" type="password" autocomplete="off" spellcheck="false" required>
      </div>
      <button type="submit">${escapeHtml(t.unlock)}</button>
    </form>
    <p class="error" id="signin-error" hidden></p>
    <p class="muted">${escapeHtml(t.tokenNote)}</p>
  </section>

  <div id="console" hidden>
    <p class="error" id="console-error" hidden></p>

    <h2>${escapeHtml(t.membersHeading)}</h2>
    <table>
      <thead><tr><th>${escapeHtml(t.colId)}</th><th>${escapeHtml(t.colDailyLimit)}</th><th>${escapeHtml(t.colCreated)}</th><th>${escapeHtml(t.colRevoked)}</th><th></th></tr></thead>
      <tbody id="members-body"></tbody>
    </table>
    <p class="muted" id="members-empty" hidden>${escapeHtml(t.membersEmpty)}</p>

    <div class="card">
      <form class="row" id="member-form">
        <div>
          <label for="member-id">${escapeHtml(t.newMemberIdLabel)}</label>
          <input id="member-id" required>
        </div>
        <div>
          <label for="member-limit">${escapeHtml(t.colDailyLimit)}</label>
          <input id="member-limit" type="number" min="0" step="1" value="50" required>
        </div>
        <button type="submit">${escapeHtml(t.createMember)}</button>
      </form>
      <div id="member-result" hidden></div>
    </div>

    <h2>${escapeHtml(t.invitesHeading)}</h2>
    <table>
      <thead><tr><th>${escapeHtml(t.colMemberId)}</th><th>${escapeHtml(t.colDailyLimit)}</th><th>${escapeHtml(t.colStatus)}</th><th>${escapeHtml(t.colExpires)}</th><th>${escapeHtml(t.colEmail)}</th><th></th></tr></thead>
      <tbody id="invites-body"></tbody>
    </table>
    <p class="muted" id="invites-empty" hidden>${escapeHtml(t.invitesEmpty)}</p>

    <div class="card">
      <form class="row" id="invite-form">
        <div>
          <label for="invite-member">${escapeHtml(t.memberIdLabel)}</label>
          <input id="invite-member" required>
        </div>
        <div>
          <label for="invite-limit">${escapeHtml(t.colDailyLimit)}</label>
          <input id="invite-limit" type="number" min="0" step="1" value="50" required>
        </div>
        <div>
          <label for="invite-email">${escapeHtml(t.emailOptionalLabel)}</label>
          <input id="invite-email" type="email">
        </div>
        <div>
          <label for="invite-ttl">${escapeHtml(t.ttlHoursLabel)}</label>
          <input id="invite-ttl" type="number" min="1" step="1">
        </div>
        <button type="submit">${escapeHtml(t.createInvite)}</button>
      </form>
      <div id="invite-result" hidden></div>
    </div>
  </div>
</main>
<script nonce="${nonce}">
(function () {
  'use strict';

  // The dictionary crosses as DATA, not as interpolated code: every string
  // below is looked up on this object, so a translation can never become a
  // syntax error or an injection point in the page it is rendered into.
  var T = ${scriptJson(t)};
  var LANG = ${scriptJson(language)};

  /** Same {name} substitution as the server's fill(), for the same strings. */
  function fill(template, values) {
    return template.replace(/\\{(\\w+)\\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match;
    });
  }

  /**
   * The API returns InviteStatus as a raw enum value. An unknown one is shown
   * as-is rather than blanked: a new status the console has not learned yet is
   * still more useful on screen than nothing.
   */
  function statusLabel(status) {
    if (status === 'pending') return T.statusPending;
    if (status === 'redeemed') return T.statusRedeemed;
    if (status === 'expired') return T.statusExpired;
    if (status === 'revoked') return T.statusRevoked;
    return status;
  }

  var MEMBERS = ${JSON.stringify(MEMBERS_PATH)};
  var INVITES = ${JSON.stringify(INVITES_PATH)};
  var GATEWAY_INFO = ${JSON.stringify(GATEWAY_INFO_PATH)};

  // The admin token, for the lifetime of this page object and no longer.
  var adminToken = null;

  function byId(id) { return document.getElementById(id); }

  function show(node, text) {
    if (text !== undefined) node.textContent = text;
    node.hidden = false;
  }

  function hide(node) { node.hidden = true; }

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function ApiError(status, message) {
    this.status = status;
    this.message = message;
  }

  function messageOf(payload, status) {
    if (payload && payload.error && typeof payload.error.message === 'string') return payload.error.message;
    return fill(T.gatewayAnswered, { status: status });
  }

  function request(method, path, body) {
    var init = { method: method, headers: { Authorization: 'Bearer ' + adminToken } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (response) {
      return response.text().then(function (text) {
        var payload = null;
        try { payload = JSON.parse(text); } catch (ignored) { payload = null; }
        if (!response.ok) throw new ApiError(response.status, messageOf(payload, response.status));
        return payload;
      });
    });
  }

  function formatTime(value) {
    if (!value) return '—';
    var parsed = new Date(value);
    if (isNaN(parsed.getTime())) return String(value);
    return parsed.toLocaleString(LANG);
  }

  function copyButton(value) {
    var button = el('button', T.copy);
    button.type = 'button';
    button.addEventListener('click', function () {
      var done = function () { button.textContent = T.copied; };
      var failed = function () { button.textContent = T.selectAndCopy; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(done, failed);
        return;
      }
      failed();
    });
    return button;
  }

  function secretRow(label, value) {
    var wrap = el('div');
    wrap.appendChild(el('div', label, 'muted'));
    var row = el('div', undefined, 'secret');
    row.appendChild(el('code', value));
    row.appendChild(copyButton(value));
    wrap.appendChild(row);
    return wrap;
  }

  function actionButton(label, onClick) {
    var button = el('button', label);
    button.type = 'button';
    button.addEventListener('click', onClick);
    return button;
  }

  function reportError(error) {
    var node = byId('console-error');
    show(node, error && error.message ? error.message : T.somethingWentWrong);
  }

  function clearError() { hide(byId('console-error')); }

  // ── Members ───────────────────────────────────────────────────────────────

  function revokeMember(id) {
    if (!window.confirm(fill(T.confirmRevokeMember, { id: id }))) return;
    clearError();
    request('DELETE', MEMBERS + '/' + encodeURIComponent(id))
      .then(loadMembers)
      .catch(reportError);
  }

  function memberRow(member) {
    var row = el('tr');
    row.appendChild(el('td', member.id));
    row.appendChild(el('td', member.dailyLimit));
    row.appendChild(el('td', formatTime(member.createdAt)));
    row.appendChild(el('td', member.revokedAt ? formatTime(member.revokedAt) : '—'));
    var actions = el('td');
    if (!member.revokedAt) {
      actions.appendChild(actionButton(T.revoke, function () { revokeMember(member.id); }));
    }
    row.appendChild(actions);
    return row;
  }

  function loadMembers() {
    return request('GET', MEMBERS).then(function (payload) {
      var body = byId('members-body');
      body.textContent = '';
      var members = (payload && payload.members) || [];
      members.forEach(function (member) { body.appendChild(memberRow(member)); });
      byId('members-empty').hidden = members.length > 0;
    });
  }

  function createMember(event) {
    event.preventDefault();
    clearError();
    var result = byId('member-result');
    hide(result);
    request('POST', MEMBERS, {
      id: byId('member-id').value.trim(),
      dailyLimit: Number(byId('member-limit').value)
    }).then(function (payload) {
      result.textContent = '';
      result.appendChild(el('p', fill(T.memberCreated, { id: payload.member.id })));
      result.appendChild(secretRow(T.memberTokenLabel, payload.token));
      result.appendChild(el('p', T.memberTokenNote, 'muted'));
      show(result);
      byId('member-form').reset();
      return loadMembers();
    }).catch(reportError);
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  function revokeInvite(invite) {
    if (!window.confirm(fill(T.confirmRevokeInvite, { id: invite.memberId }))) return;
    clearError();
    request('DELETE', INVITES + '/' + encodeURIComponent(invite.id))
      .then(loadInvites)
      .catch(reportError);
  }

  function inviteRow(invite) {
    var row = el('tr');
    row.appendChild(el('td', invite.memberId));
    row.appendChild(el('td', invite.dailyLimit));
    row.appendChild(el('td', statusLabel(invite.status), 'status-' + invite.status));
    row.appendChild(el('td', formatTime(invite.expiresAt)));
    row.appendChild(el('td', invite.email || '—'));
    var actions = el('td');
    if (invite.status === 'pending') {
      actions.appendChild(actionButton(T.revoke, function () { revokeInvite(invite); }));
    }
    row.appendChild(actions);
    return row;
  }

  function loadInvites() {
    return request('GET', INVITES).then(function (payload) {
      var body = byId('invites-body');
      body.textContent = '';
      var invites = (payload && payload.invites) || [];
      invites.forEach(function (invite) { body.appendChild(inviteRow(invite)); });
      byId('invites-empty').hidden = invites.length > 0;
    });
  }

  function inviteBody() {
    var body = {
      memberId: byId('invite-member').value.trim(),
      dailyLimit: Number(byId('invite-limit').value)
    };
    var email = byId('invite-email').value.trim();
    if (email) body.email = email;
    var ttl = byId('invite-ttl').value.trim();
    if (ttl) body.ttlHours = Number(ttl);
    return body;
  }

  function createInvite(event) {
    event.preventDefault();
    clearError();
    var result = byId('invite-result');
    hide(result);
    request('POST', INVITES, inviteBody()).then(function (payload) {
      result.textContent = '';
      result.appendChild(el('p', fill(T.inviteCreated, { id: payload.memberId })));
      if (payload.link) {
        result.appendChild(secretRow(T.inviteLinkLabel, payload.link));
      } else {
        result.appendChild(el('p', T.inviteNoLink, 'muted'));
      }
      result.appendChild(secretRow(T.inviteTokenLabel, payload.token));
      result.appendChild(el('p', payload.emailed ? T.inviteEmailSent : T.inviteEmailNotSent, 'muted'));
      show(result);
      byId('invite-form').reset();
      return loadInvites();
    }).catch(reportError);
  }

  // ── Sign in ───────────────────────────────────────────────────────────────

  function signIn(event) {
    event.preventDefault();
    var errorNode = byId('signin-error');
    hide(errorNode);
    adminToken = byId('admin-token').value;
    // The list call IS the check: there is no login endpoint, and inventing one
    // would be a second place the token is compared.
    loadMembers().then(function () {
      byId('admin-token').value = '';
      hide(byId('signin'));
      show(byId('console'));
      return loadInvites();
    }).catch(function (error) {
      adminToken = null;
      show(errorNode, error && error.status === 401
        ? T.tokenRejected
        : (error && error.message) || T.gatewayUnreachable);
    });
  }

  function loadGatewayInfo() {
    fetch(GATEWAY_INFO).then(function (response) {
      return response.ok ? response.json() : null;
    }).then(function (info) {
      if (!info || !info.auditEnabled) return;
      show(byId('mode-line'), T.auditModeLine);
    }).catch(function () { /* The page works without it. */ });
  }

  byId('signin-form').addEventListener('submit', signIn);
  byId('member-form').addEventListener('submit', createMember);
  byId('invite-form').addEventListener('submit', createInvite);
  loadGatewayInfo();
})();
</script>
</body>
</html>
`;
}

/**
 * `GET /ui`, and nothing else.
 *
 * Mounted by `create-app.ts` in front of the admin bearer auth and inside the
 * same "is an admin token configured" branch as the API — so the page appears
 * and disappears with the API it drives, and `/admin/ui` on an unconfigured
 * gateway reaches the same 404 as `/admin/members`.
 */
export function createAdminUiRoutes(language: GatewayLanguage): Router {
  const router = Router();

  router.get('/ui', (_req: Request, res: Response) => {
    // `base64url`, not `base64`: the CSP grammar accepts `-` and `_`, and a
    // nonce with a `/` in it can spell a path fragment that the page's own
    // "references no new endpoint" test would then have to reason about.
    const nonce = randomBytes(16).toString('base64url');
    res.status(200);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce));
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // The document is public but personal to the operator's session; a shared
    // cache holding it buys nothing and a stale one confuses.
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderAdminUiPage(nonce, language));
  });

  return router;
}
