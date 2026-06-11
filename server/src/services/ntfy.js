// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ntfy.sh INTEGRATION — phone push for out-of-app agent alerts
//
//  Why ntfy.sh:
//  - Free at the hosted endpoint, MIT-licensed self-host option
//  - No SDK, no accounts, no API keys: POST to https://ntfy.sh/<topic>
//  - iOS + Android apps; subscribe to your private topic = lock-screen
//    notifications wherever you are
//  - Topic = the auth boundary: keep your topic name secret (we generate
//    16 hex = 64 bits of entropy per agent, stored in
//    support_agent_presence.ntfy_topic) and a random subscriber can't
//    spam you
//
//  Operational notes:
//  - The hosted endpoint is rate-limited (~5 req/s per IP for anonymous
//    publishers); for solo-dev support volume this is plenty. If the rate
//    ever bites, switch to a self-hosted instance by setting
//    NTFY_SERVER_URL on the deploy target. No code change.
//  - This module is fire-and-forget. We log on failure but never throw
//    upstream — a third-party outage on the push channel must not cascade
//    into a 500 on the customer's "Talk to a human" flow.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

'use strict';

const NTFY_SERVER_URL = (process.env.NTFY_SERVER_URL || 'https://ntfy.sh').replace(/\/+$/, '');

// Priority maps to ntfy's 1-5 scale where 1 = min (no sound), 5 = max
// (bypasses Do-Not-Disturb on most platforms). Most alerts here are
// priority 4 (high — vibrate + sound, but not DND-piercing). Reserve
// 5 for genuine "drop everything" cases like a billing dispute.
const PRIORITY = {
  min: 1,
  low: 2,
  default: 3,
  high: 4,
  max: 5,
};

/**
 * Send a push notification to a specific ntfy topic.
 *
 * @param {string} topic - The agent's private topic (from support_agent_presence)
 * @param {object} opts
 * @param {string} opts.title    - The notification title (becomes the bold first line)
 * @param {string} opts.body     - The notification body text
 * @param {number} [opts.priority] - 1-5, see PRIORITY map above. Default 4 (high)
 * @param {string[]} [opts.tags] - Emoji shortcodes for visual flair (e.g. ['speech_balloon'])
 * @param {string} [opts.click]  - URL to open when the user taps the notification
 * @param {Array<{action:string, label:string, url?:string, body?:string}>} [opts.actions]
 *                               - Action buttons rendered on the lock screen
 *                                 (e.g. [{action:'view', label:'Open chat', url:'https://...'}])
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function sendNtfy(topic, { title, body, priority = PRIORITY.high, tags, click, actions } = {}) {
  if (!topic || typeof topic !== 'string') {
    return { ok: false, error: 'missing topic' };
  }
  if (!body) {
    return { ok: false, error: 'missing body' };
  }
  const url = `${NTFY_SERVER_URL}/${encodeURIComponent(topic)}`;
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Priority': String(priority),
  };
  // ntfy expects headers as ASCII; titles with non-ASCII chars must be
  // base64-encoded per their spec (RFC 2047-ish). Easy heuristic:
  // if the title has any non-ASCII byte, base64 it.
  if (title) {
    // eslint-disable-next-line no-control-regex
    const isAscii = /^[\x00-\x7f]*$/.test(title);
    if (isAscii) {
      headers['Title'] = title;
    } else {
      // eslint-disable-next-line no-undef
      headers['Title'] = `=?utf-8?B?${Buffer.from(title, 'utf8').toString('base64')}?=`;
    }
  }
  if (Array.isArray(tags) && tags.length > 0) {
    headers['Tags'] = tags.join(',');
  }
  if (click) headers['Click'] = click;
  if (Array.isArray(actions) && actions.length > 0) {
    // ntfy actions header format:
    //   action=view, label=Open, url=https://example.com; \
    //   action=http, label=Done, url=..., method=POST
    headers['Actions'] = actions
      .map(a => {
        const parts = [`action=${a.action}`, `label=${a.label}`];
        if (a.url) parts.push(`url=${a.url}`);
        if (a.body) parts.push(`body=${a.body}`);
        if (a.method) parts.push(`method=${a.method}`);
        if (a.clear) parts.push(`clear=true`);
        return parts.join(', ');
      })
      .join('; ');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[ntfy] non-2xx', res.status, text.slice(0, 200));
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    // Network error, timeout, or AbortError — log warn not error since
    // this is a non-critical alerting channel.
    console.warn('[ntfy] send failed:', err && err.message);
    return { ok: false, error: err && err.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Helper for the common "a customer needs help" alert. Builds a sane
 * default payload (title, body, priority, tap-to-open URL, two action
 * buttons) and ships it. Callers pass the agent's topic and the thread
 * context; this module owns the formatting so we have one place to
 * change the message style.
 */
async function sendNewCustomerAlert(topic, { customerName, customerEmail, question, threadId, dashboardUrl }) {
  const title = `New chat: ${customerName || customerEmail || 'customer'}`;
  const truncated = question && question.length > 200
    ? question.slice(0, 197) + '...'
    : (question || 'Customer joined the live chat.');
  const click = dashboardUrl || (process.env.SERVER_URL ? `${process.env.SERVER_URL}/admin/support/${threadId}` : undefined);
  return sendNtfy(topic, {
    title,
    body: truncated,
    priority: PRIORITY.high,
    tags: ['speech_balloon'],
    click,
    actions: click ? [{ action: 'view', label: 'Open chat', url: click }] : undefined,
  });
}

module.exports = {
  sendNtfy,
  sendNewCustomerAlert,
  PRIORITY,
  NTFY_SERVER_URL,
};
