// D-088: what a user reads when something goes wrong (core/usermsg.ts) and the chat relay's coded replies.
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/core/api';
import { MSG, UserError, chatCodeOf, chatError, chatMessage, couldNot, friendlyError, looksInternal } from '../src/core/usermsg';
import { plainReason } from '../src/core/chat';

const INTERNAL = /thingsboard|DBB|LLM|asset|attribute|rule chain|relay|tenant|JSON|HTTP|\b[45]\d\d\b|Error\b|api key|x-api-key|anthropic|openai|gemini|\/api\//i;

describe('the shared sentences (same words as the iMEX app, AI Insights and Reports)', () => {
  it('match the agreed wording', () => {
    expect(MSG.noAccess).toBe('Your role does not allow this. If you need it, ask your administrator.');
    expect(MSG.notLicensed).toBe('This is not included in your license. Contact your administrator.');
    expect(MSG.unavailable).toBe('This is not available right now. Please try again in a few minutes. If it keeps happening, contact your administrator.');
    expect(MSG.aiUnavailable).toBe('AI is not available right now. Contact your ITHENA administrator.');
    expect(MSG.changed).toBe('Someone else changed this in the meantime. Reload the page and try again.');
    expect(MSG.noData).toBe('No data for this period yet.');
  });
  it('carry no internals', () => {
    for (const s of Object.values(MSG)) expect(looksInternal(s), s).toBe(false);
  });
});

describe('friendlyError', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  it('keeps a message written for the user', () => {
    expect(friendlyError(new UserError('This dashboard is too large to save.'))).toBe('This dashboard is too large to save.');
  });
  it('turns a refused platform call into a sentence by status, the detail in the console', () => {
    const w = quiet();
    expect(friendlyError(new ApiError(403, '/api/plugins/telemetry/ASSET/x/attributes/SERVER_SCOPE', '{"status":403,"message":"You don\'t have permission"}'), 'save the dashboard')).toBe(MSG.noAccess);
    expect(friendlyError(new ApiError(404, '/api/x', ''))).toBe(MSG.notFound);
    expect(friendlyError(new ApiError(409, '/api/x', ''))).toBe(MSG.changed);
    expect(friendlyError(new ApiError(401, 'auth', 'Not logged in'))).toBe(MSG.session);
    expect(friendlyError(new ApiError(502, '/api/x', 'Bad gateway'), 'load the dashboards')).toBe(couldNot('load the dashboards'));
    expect(friendlyError(new ApiError(500, '/api/x', 'java.lang.NullPointerException'))).toBe(MSG.unavailable);
    expect(w).toHaveBeenCalled();
    expect(String(w.mock.calls[0][0])).toMatch(/^\[dbb\]/);
    w.mockRestore();
  });
  it('never passes exception text through', () => {
    const w = quiet();
    expect(friendlyError(new TypeError("Cannot read properties of undefined (reading 'id')"), 'open the dashboard')).toBe(couldNot('open the dashboard'));
    expect(friendlyError(new Error('ZodError: [{"path":["widgets",0]}]'))).toBe(MSG.generic);
    expect(friendlyError(new TypeError('Failed to fetch'), 'load the data')).toBe(couldNot('load the data'));
    expect(friendlyError('400 /api/x: {"a":1}')).toBe(MSG.generic);
    expect(friendlyError('Choose a machine first.')).toBe('Choose a machine first.');
    w.mockRestore();
  });
  it('"Could not <action> right now" names the next step', () => {
    expect(couldNot('save the dashboard.')).toBe('Could not save the dashboard right now. Please try again in a few minutes. If it keeps happening, contact your administrator.');
  });
});

describe('the chat assistant (relay replies)', () => {
  const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  it('an expired or wrong AI key reads "AI is not available right now", from the old relay text too', () => {
    const w = quiet();
    for (const old of [
      'No LLM API key is set. A tenant admin sets dbb_llm_api_key (Claude, OpenAI or Gemini key) on the asset DBB-LLM-CONFIG.',
      'The anthropic API key on DBB-LLM-CONFIG is invalid or has no access to the model.',
      'The gemini model was not found. Set dbb_llm_model_gemini on the LLM config asset.',
      'The chat relay could not read the LLM settings or build the request. Check that asset DBB-LLM-CONFIG exists and is linked to this store (relation UsesLlmConfig).',
      'openai rejected the request: {"error":{"message":"Incorrect API key provided"}}',
      'LLM call failed (error)',
    ]) {
      expect(chatError({ ok: false, error: old }).message, old).toBe(MSG.aiUnavailable);
    }
    expect(chatError({ ok: false, code: 'AI_UNAVAILABLE', error: MSG.aiUnavailable, detail: 'invalid x-api-key', status: '401' }).message).toBe(MSG.aiUnavailable);
    expect(w).toHaveBeenCalled();
    w.mockRestore();
  });
  it('a busy or unreachable provider is "try again" and keeps the retry code', () => {
    const w = quiet();
    const e = chatError({ ok: false, error: "The gemini service is overloaded right now (a temporary problem on the provider's side). Try again in a minute." });
    expect(e.kind).toBe('AI_BUSY');
    expect(e.message).toBe(MSG.aiBusy);
    expect(chatCodeOf('Could not reach the openai service (a network problem between ThingsBoard and the provider). Try again in a moment.')).toBe('AI_BUSY');
    expect(chatCodeOf('The anthropic API is rate-limited or out of credit. Try again later or switch the key.')).toBe('AI_BUSY');
    w.mockRestore();
  });
  it('maps every relay case to one sentence without internals', () => {
    const w = quiet();
    const cases: Array<[string, RegExp]> = [
      ['Chat limit reached (60 requests per hour). Try again later.', /60 requests per hour/],
      ["The chat assistant is not included in this installation's license. Ask your administrator.", /^This is not included in your license. Contact your administrator.$/],
      ['Monthly AI limit reached (12 of 10) — contact your administrator', /\(12 of 10\)/],
      ['AI (LLM) use is switched off for the Dashboard builder chat. An administrator can switch it on in Configuration › General › AI (LLM) usage.', /switched off/],
      ['The chat could not read the AI switches of the application, so it stays off. Ask your administrator.', /not available right now/],
      ['This page is running an older version of the Dashboard Builder. Reload the page (Ctrl+F5) and try again.', /Reload the page/],
      ['The chat request did not come from your user. Reload the page and try again.', /Reload the page/],
      ["Your role can't use the chat assistant (it needs Build dashboards). Ask your administrator.", /Build dashboards/],
      ['Your role could not be checked, so the chat stays off. Try again; if it keeps happening, ask your administrator.', /could not be checked/],
      ['The chat request is too large. Start a new conversation or ask for fewer changes at once.', /too long/],
      ['The model returned no dashboard operations.', /did not return an answer/],
    ];
    for (const [old, want] of cases) {
      const m = chatError({ ok: false, error: old }).message;
      expect(m, old).toMatch(want);
      expect(INTERNAL.test(m), m).toBe(false);
    }
    expect(chatError({ ok: false, code: 'QUOTA', qUsed: '5', qLimit: '5', error: 'x' }).message).toMatch(/\(5 of 5\)/);
    w.mockRestore();
  });
  it('the relay script writes the same sentences as chatMessage', async () => {
    const { readFileSync } = await import('node:fs');
    const all = readFileSync(new URL('../deploy/deploy-browser.js', import.meta.url), 'utf8');
    const src = all.slice(all.indexOf('const AI_NA = '), all.indexOf("].join('\\n')", all.indexOf('const errScript = [')));
    expect(src.length).toBeGreaterThan(1000);
    for (const code of ['AI_UNAVAILABLE', 'AI_BUSY', 'AI_OFF', 'AI_SW', 'NOT_LICENSED', 'ROLE', 'ROLE_ERR', 'TOO_BIG', 'RELOAD', 'NO_OPS'] as const) {
      // NO_OPS is written by "Parse LLM reply", the others by "Error reply"
      const where = code === 'NO_OPS' ? all : src;
      const s = chatMessage(code).replace(/'/g, "\\'");
      expect(where.includes(s) || where.includes(chatMessage(code)), code).toBe(true);
    }
    // the old texts with internal names are gone from the relay
    expect(src).not.toMatch(/rejected the request|API key on|dbb_llm_model_|between ThingsBoard and the provider|could not read the LLM settings/);
  });
});

describe('plainReason (a model problem shown in "I couldn\'t build that: ...")', () => {
  it('keeps plain words, drops aliases, op names and schema paths', () => {
    expect(plainReason('Compressor has no property vibration. Available: temperature, pressure.')).toBe(true);
    expect(plainReason('ops.0.binding.mode: Invalid enum value')).toBe(false);
    expect(plainReason('unknown machine alias in D3, D4.')).toBe(false);
    expect(plainReason('startNewDashboard must be the first op.')).toBe(false);
    expect(plainReason('no widget W7.')).toBe(false);
  });
});
