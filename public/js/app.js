(() => {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Builds DOM safely: all user text goes through textContent / text nodes (no innerHTML).
  function h(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }

  const state = {
    token: localStorage.getItem('token'),
    config: { emailEnabled: true, smsEnabled: false },
    scope: localStorage.getItem('scope') === 'state' ? 'state' : 'district',
    settingsTab: 'profile',
    me: null,
    socket: null,
    online: new Set(),
    users: {},            // cache: id -> public user
    tab: 'chats',
    conversations: [],
    people: [],
    view: 'home',         // home | profile | chat | edit
    activeId: null,
    messages: [],
    hasMore: false,
    msgEls: new Map(),    // message id -> meta element (for read receipts)
    lastDay: null,
    typingTimer: null,
    typingSent: false,
    iceServers: null,
    call: null,           // active/outgoing call
    incoming: null,       // ringing incoming call
  };

  const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const cache = (u) => { state.users[u.id] = { ...state.users[u.id], ...u }; return state.users[u.id]; };

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function avatar(user, size = 40, withDot = false) {
    const sized = (el) => { el.style.width = el.style.height = size + 'px'; el.style.fontSize = Math.round(size * 0.4) + 'px'; el.style.background = user.avatarColor || '#5b5bf0'; return el; };
    const letters = () => sized(h('div', { class: 'avatar' }, initials(user.displayName)));
    let a;
    if (user.avatarUrl) {
      a = sized(h('img', { class: 'avatar', src: size <= 64 ? user.avatarThumb || user.avatarUrl : user.avatarUrl, alt: '', loading: 'lazy' }));
      a.addEventListener('error', () => a.replaceWith(letters())); // picture missing: show the initials instead
    } else a = letters();
    if (!withDot) return a;
    return h('div', { class: 'avatar-wrap', 'data-uid': user.id }, a,
      h('span', { class: 'dot' + (state.online.has(user.id) ? ' on' : '') }));
  }

  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (iso) => {
    const d = new Date(iso), today = new Date();
    const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const statusText = (id) => {
    if (state.online.has(id)) return 'Online';
    const u = state.users[id];
    return u && u.lastSeen ? 'Last seen ' + fmtDay(u.lastSeen) + ' ' + fmtTime(u.lastSeen) : 'Offline';
  };

  // A login that just happened counts as "recent" for 14 minutes (the server allows 15), so setup stays smooth.
  function setToken(token) {
    state.token = token;
    localStorage.setItem('token', token);
    state.recentUntil = Date.now() + 14 * 60 * 1000;
  }
  const tokenRecent = () => Date.now() < (state.recentUntil || 0);

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token) { logout(); throw new Error('Session expired. Please log in again.'); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { status: res.status, code: data.code, retryAfter: data.retryAfter, fields: data.fields });
    return data;
  }

  /* ---------- auth ---------- */
  const authTimers = new Set();
  function showAuthPanel(name) {
    authTimers.forEach(clearInterval); authTimers.clear(); clearInterval(forgotTimer);
    $('#auth-tabs').hidden = name === 'forgot';
    $$('[data-auth-tab]').forEach((x) => x.classList.toggle('active', x.dataset.authTab === name));
    $('#login-box').hidden = name !== 'login';
    $('#signup-box').hidden = name !== 'register';
    $('#forgot-box').hidden = name !== 'forgot';
    $('#google-box').hidden = name === 'forgot' || !googleReady;
    if (name === 'forgot') renderForgot(1);
    else if (name === 'login') renderLogin(1);
    else renderSignup('form');
  }
  $$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => showAuthPanel(b.dataset.authTab)));

  // Forgot password: 1) say who you are, 2) enter the code we send and choose a new password
  let forgotTimer;
  function renderForgot(step, identifier = '') {
    clearInterval(forgotTimer);
    const box = $('#forgot-box'); const err = h('p', { class: 'error' });
    const guarded = (form, fn) => form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      const btn = $('button[type=submit]', form); btn.disabled = true;
      try { await fn(); } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
    });
    if (step === 1) {
      const input = h('input', { name: 'identifier', value: identifier, required: true, autocomplete: 'username', placeholder: 'you@example.com, username or +33 6 12…' });
      const form = h('form', { class: 'form' },
        h('h2', {}, 'Forgot your password?'),
        h('p', { class: 'muted' }, 'Enter the email, username or phone number of your account and we will send you a 6-digit code.'),
        h('label', {}, 'Email, username or phone', input), err,
        h('button', { class: 'btn primary', type: 'submit' }, 'Send code'),
        h('button', { class: 'btn', type: 'button', onClick: () => showAuthPanel('login') }, 'Back to log in'));
      guarded(form, async () => { await api('/auth/forgot', { method: 'POST', body: { identifier: input.value } }); renderForgot(2, input.value.trim()); });
      box.replaceChildren(form); input.focus();
      return;
    }
    const code = h('input', { name: 'code', inputmode: 'numeric', maxlength: 7, autocomplete: 'one-time-code', placeholder: '123456', required: true, class: 'code-input' });
    const pw = h('input', { name: 'newPassword', type: 'password', minlength: 8, required: true, autocomplete: 'new-password' });
    const resend = h('button', { class: 'btn small', type: 'button' });
    const form = h('form', { class: 'form' },
      h('h2', {}, 'Enter your code'),
      h('p', { class: 'muted' }, 'If an account matches, a code is on its way. It works for 10 minutes.'),
      h('label', {}, '6-digit code', code),
      h('label', {}, 'New password (min 8 characters)', pw), err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Reset password'),
      resend,
      h('button', { class: 'btn', type: 'button', onClick: () => renderForgot(1, identifier) }, 'Use a different account'));
    let left = 60;
    const tick = () => { resend.disabled = left > 0; resend.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code'; };
    tick(); forgotTimer = setInterval(() => { if (left > 0) { left--; tick(); } }, 1000);
    resend.addEventListener('click', async () => {
      try { await api('/auth/forgot', { method: 'POST', body: { identifier } }); left = 60; tick(); toast('If the account exists, a new code was sent.'); }
      catch (ex) { err.textContent = ex.message; }
    });
    guarded(form, async () => {
      const { token, user } = await api('/auth/reset', { method: 'POST', body: { identifier, code: code.value, newPassword: pw.value } });
      setToken(token);
      clearInterval(forgotTimer); toast('Password updated. You are logged in.');
      startApp(user);
    });
    box.replaceChildren(form); code.focus();
  }

  // Runs a form handler with the button disabled and any error shown in red under the form.
  function guardedForm(form, errEl, fn) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); errEl.textContent = '';
      const btn = $('button[type=submit]', form); if (btn) btn.disabled = true;
      try { await fn(Object.fromEntries(new FormData(form))); } catch (ex) { errEl.textContent = ex.message; }
      finally { if (btn) btn.disabled = false; }
    });
  }
  // "Resend code in 42s" button
  function resendButton(onResend, errEl) {
    const btn = h('button', { class: 'btn small', type: 'button' });
    let left = 60;
    const tick = () => { btn.disabled = left > 0; btn.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code'; };
    tick();
    const timer = setInterval(() => { if (!btn.isConnected) { clearInterval(timer); authTimers.delete(timer); return; } if (left > 0) { left--; tick(); } }, 1000);
    authTimers.add(timer);
    btn.addEventListener('click', async () => {
      try { errEl.textContent = ''; await onResend(); left = 60; tick(); toast('A new code was sent.'); } catch (ex) { errEl.textContent = ex.message; }
    });
    return btn;
  }
  const codeInput = () => h('input', { name: 'code', inputmode: 'numeric', maxlength: 7, autocomplete: 'one-time-code', placeholder: '123456', required: true, class: 'code-input' });

  /* ---------- log in: username, phone number or email -> code ---------- */
  const lg = { identifier: '', mode: 'code' };
  function renderLogin(step = 1) {
    if (!state.config.codesRequired) lg.mode = 'password'; // codes are switched off: password login only
    const box = $('#login-box'); const err = h('p', { class: 'error' });
    if (lg.mode === 'password') {
      const id = h('input', { name: 'identifier', value: lg.identifier, required: true, autocomplete: 'username' });
      const form = h('form', { class: 'form' },
        h('label', {}, 'Username, phone number or email', id),
        h('label', {}, 'Password', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
        err, h('button', { class: 'btn primary', type: 'submit' }, 'Log in'),
        state.config.codesRequired ? h('div', { class: 'row between' },
          h('button', { class: 'link', type: 'button', onClick: () => showAuthPanel('forgot') }, 'Forgot password?'),
          h('button', { class: 'link', type: 'button', onClick: () => { lg.mode = 'code'; renderLogin(1); } }, 'Log in with a code instead')) : null);
      guardedForm(form, err, async (f) => {
        lg.identifier = f.identifier.trim();
        const { token, user } = await api('/auth/login', { method: 'POST', body: f });
        setToken(token); startApp(user);
      });
      return box.replaceChildren(form);
    }
    if (step === 1) {
      const id = h('input', { name: 'identifier', value: lg.identifier, required: true, autocomplete: 'username', placeholder: 'Username, phone number or email' });
      const form = h('form', { class: 'form' },
        h('label', {}, 'Username, phone number or email', id),
        err, h('button', { class: 'btn primary', type: 'submit' }, 'Send code'),
        h('button', { class: 'link', type: 'button', onClick: () => { lg.mode = 'password'; renderLogin(1); } }, 'I have a password'));
      guardedForm(form, err, async (f) => {
        lg.identifier = f.identifier.trim();
        await api('/auth/login-code', { method: 'POST', body: { identifier: lg.identifier } });
        renderLogin(2);
      });
      box.replaceChildren(form); id.focus(); return;
    }
    const code = codeInput();
    const form = h('form', { class: 'form' },
      h('h2', {}, 'Enter your code'),
      h('p', { class: 'muted' }, 'If an account matches, we sent a 6-digit code to its phone number (or email). It works for 10 minutes.'),
      h('label', {}, '6-digit code', code), err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Log in'),
      resendButton(() => api('/auth/login-code', { method: 'POST', body: { identifier: lg.identifier } }), err),
      h('button', { class: 'btn', type: 'button', onClick: () => renderLogin(1) }, 'Use a different account'));
    guardedForm(form, err, async () => {
      const { token, user } = await api('/auth/login-verify', { method: 'POST', body: { identifier: lg.identifier, code: code.value } });
      setToken(token); startApp(user);
    });
    box.replaceChildren(form); code.focus();
  }

  /* ---------- sign up: details -> a code to the email AND a code to the phone -> account ---------- */
  const su = { values: { displayName: '', username: '', email: '', phone: '' }, id: null, email: '', phone: '' };

  function renderSignup(step = 'form') {
    const box = $('#signup-box');
    if (step === 'verify') return renderSignupVerify(box);
    const err = h('p', { class: 'error' });
    const fields = {};
    const makeField = (name, label, attrs) => {
      const input = h('input', { name, value: su.values[name], required: true, ...attrs });
      const msg = h('div', { class: 'field-msg' });
      fields[name] = { input, msg };
      return h('label', {}, label, input, msg);
    };
    // red = a problem, green = fine. "Log in instead" appears when the number/email already has an account.
    const setMsg = (name, ok, text, offerLogin) => {
      const f = fields[name]; f.msg.className = 'field-msg' + (ok === true ? ' ok' : ok === false ? ' bad' : ''); f.msg.textContent = text || '';
      f.input.classList.toggle('invalid', ok === false);
      if (offerLogin) f.msg.append(' ', h('button', { class: 'link', type: 'button', onClick: () => { lg.identifier = f.input.value.trim(); lg.mode = 'code'; showAuthPanel('login'); } }, 'Log in instead'));
    };
    const timers = {};
    const check = (name, delay) => {
      clearTimeout(timers[name]);
      const value = fields[name].input.value.trim();
      if (!value) return setMsg(name, null, '');
      timers[name] = setTimeout(async () => {
        try {
          const r = await api(`/auth/availability?${name}=${encodeURIComponent(value)}`);
          if (fields[name].input.value.trim() !== value) return; // typed more meanwhile
          const info = r[name]; if (!info) return;
          setMsg(name, info.ok, info.ok ? (name === 'username' ? 'This username is available.' : '') : info.message, !info.ok && /already has an account/.test(info.message));
        } catch { /* offline: the server checks again on submit */ }
      }, delay);
    };

    const nameF = makeField('displayName', 'Your name', { maxlength: 40, autocomplete: 'name' });
    const userF = makeField('username', 'Username (nobody else can have the same)', { minlength: 3, maxlength: 20, pattern: '[A-Za-z0-9_]+', autocomplete: 'username' });
    const mailF = makeField('email', 'Email', { type: 'email', autocomplete: 'email' });
    const phoneF = makeField('phone', 'Phone number', { type: 'tel', autocomplete: 'tel', placeholder: '+91 98765 43210' });
    const codes = !!state.config.codesRequired;
    const passF = codes ? null : makeField('password', 'Password (at least 8 characters)', { type: 'password', minlength: 8, autocomplete: 'new-password' });
    const open = state.config.signupEnabled !== false;
    const form = h('form', { class: 'form' },
      nameF, userF, mailF, phoneF, passF,
      h('p', { class: 'muted small-note' }, codes ? 'We will send a code to your email and another to your phone. After you enter both, we ask a few more details.' : 'Your email and phone number are saved on your account (each can belong to one account only). After this we ask a few more details.'),
      err,
      open ? null : h('p', { class: 'error' }, 'Sign-up is not available right now because email and text messages are not set up on this server.'),
      h('button', { class: 'btn primary', type: 'submit', disabled: !open }, codes ? 'Send verification codes' : 'Create account'));
    fields.username.input.addEventListener('input', () => check('username', 350));
    fields.email.input.addEventListener('input', () => check('email', 600)); fields.email.input.addEventListener('blur', () => check('email', 0));
    fields.phone.input.addEventListener('input', () => check('phone', 600)); fields.phone.input.addEventListener('blur', () => check('phone', 0));
    for (const f of ['displayName', 'username', 'email', 'phone']) fields[f].input.addEventListener('input', () => { su.values[f] = fields[f].input.value; });

    guardedForm(form, err, async (f) => {
      su.values = { displayName: f.displayName, username: f.username, email: f.email, phone: f.phone };
      try {
        if (!codes) { // no verification codes: the account is created right away
          const created = await api('/auth/register', { method: 'POST', body: { ...su.values, password: f.password } });
          setToken(created.token); startApp(created.user); return;
        }
        const r = await api('/auth/signup/start', { method: 'POST', body: su.values });
        Object.assign(su, { id: r.signupId, email: r.email, phone: r.phone });
        renderSignup('verify');
      } catch (ex) {
        for (const [name, msg] of Object.entries(ex.fields || {})) if (fields[name]) setMsg(name, false, msg, /already has an account/.test(msg) && name !== 'username');
        throw Object.assign(ex, { message: ex.fields ? '' : ex.message });
      }
    });
    box.replaceChildren(form); fields.displayName.input.focus();
    for (const n of ['username', 'email', 'phone']) if (su.values[n]) check(n, 0);
  }

  function renderSignupVerify(box) {
    const done = { email: false, phone: false };
    const mainErr = h('p', { class: 'error' });
    const block = (channel, title, destination) => {
      const err = h('p', { class: 'error' }); const code = codeInput();
      const form = h('form', { class: 'form code-block' },
        h('h3', {}, title),
        h('p', { class: 'muted' }, 'We sent a 6-digit code to ', h('strong', {}, destination), '.'),
        h('label', {}, '6-digit code', code), err,
        h('button', { class: 'btn primary', type: 'submit' }, 'Verify'),
        resendButton(() => api('/auth/signup/resend', { method: 'POST', body: { signupId: su.id, channel } }), err));
      guardedForm(form, err, async () => {
        let r;
        try { r = await api('/auth/signup/verify', { method: 'POST', body: { signupId: su.id, channel, code: code.value } }); }
        catch (ex) {
          if (ex.status === 410 || ex.status === 409) { // expired, or the name/number was taken in the meantime
            renderSignup('form');
            for (const [name, msg] of Object.entries(ex.fields || {})) { const el = $(`#signup-box input[name=${name}]`); if (el) { el.classList.add('invalid'); el.parentElement.querySelector('.field-msg').className = 'field-msg bad'; el.parentElement.querySelector('.field-msg').textContent = msg; } }
            toast(ex.message); return;
          }
          throw ex;
        }
        if (r.token) { setToken(r.token); toast('Both verified. Welcome!'); startApp(r.user); return; }
        done[channel] = true;
        form.replaceChildren(h('h3', {}, title), h('p', { class: 'verified' }, '✓ Verified'), h('p', { class: 'muted' }, 'Now enter the other code to finish.'));
      });
      return form;
    };
    box.replaceChildren(
      h('h2', {}, 'Verify your email and phone'),
      h('p', { class: 'muted' }, 'Enter both codes. When both are right, your account is created and we ask a few more details about you.'),
      block('email', 'Email code', su.email),
      block('phone', 'Phone code', su.phone),
      mainErr,
      h('button', { class: 'link', type: 'button', onClick: () => renderSignup('form') }, 'Wrong email or phone? Change my details'));
  }

  function logout() {
    if (state.call) endCall(true);
    localStorage.removeItem('token');
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {}); // clears the cookie that lets the browser load photos/videos
    for (const k of Object.keys(media)) delete media[k];
    state.token = null; state.me = null;
    if (state.socket) { state.socket.disconnect(); state.socket = null; }
    Object.assign(state, { feed: null, conversations: [], people: [], users: {}, view: 'home', activeId: null, messages: [], online: new Set() });
    if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
    $('#app-view').hidden = true; $('#onboarding-view').hidden = true; $('#verify-view').hidden = true; $('#auth-view').hidden = false;
    document.title = 'Connectly';
    lg.mode = 'code'; showAuthPanel('login');
  }
  $('#btn-logout').addEventListener('click', logout);

  /* ---------- start ---------- */
  let configPromise;
  function loadConfig() {
    if (!configPromise) configPromise = fetch('/api/config').then((r) => r.json()).then((c) => { state.config = c; return c; }).catch(() => state.config);
    return configPromise;
  }

  let googleReady = false;
  async function setupGoogle() {
    if (googleReady) return;
    try {
      const { googleClientId } = await loadConfig();
      if (!googleClientId) return; // not configured on this server: just hide the button
      await new Promise((resolve, reject) => {
        const sc = document.createElement('script');
        sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
        sc.onload = resolve; sc.onerror = reject; document.head.append(sc);
      });
      google.accounts.id.initialize({ client_id: googleClientId, callback: onGoogleCredential });
      google.accounts.id.renderButton($('#google-btn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill', width: 320 });
      $('#google-box').hidden = false; googleReady = true;
    } catch { /* offline or blocked: email login still works */ }
  }
  async function onGoogleCredential({ credential }) {
    $('#google-error').textContent = '';
    try {
      const { token, user } = await api('/auth/google', { method: 'POST', body: { credential } });
      setToken(token);
      startApp(user);
    } catch (e) { $('#google-error').textContent = e.message; }
  }

  async function boot() {
    setupGoogle();
    await loadConfig();
    showAuthPanel('login');
    if (!state.token) { $('#auth-view').hidden = false; return; }
    try { const { user } = await api('/me'); startApp(user); }
    catch { $('#auth-view').hidden = false; }
  }

  function startApp(user, fresh = false) {
    state.me = cache(user);
    $('#auth-view').hidden = true;
    if (state.config.codesRequired && !user.emailVerified && state.config.emailEnabled) return startVerify();
    if (state.config.codesRequired && (!user.phone || !user.phoneVerified) && state.config.smsEnabled) return startPhoneGate();
    $('#verify-view').hidden = true;
    if (!user.onboarded) return startOnboarding();
    $('#onboarding-view').hidden = true; $('#app-view').hidden = false;
    renderMeBar();
    if (!state.socket) connectSocket();
    api('/ice').then((r) => { state.iceServers = r.iceServers; }).catch(() => {});
    setTab(fresh ? 'discover' : 'chats');
    state.view = 'home'; showMain(true); renderMain();
  }

  /* ---------- shared form pieces ---------- */
  const GENDERS = [{ value: 'man', label: 'Man' }, { value: 'woman', label: 'Woman' }, { value: 'other', label: 'Other' }];
  const INTERESTED_IN = [
    { value: 'men', label: 'Men', desc: 'Men from your district' },
    { value: 'women', label: 'Women', desc: 'Women from your district' },
    { value: 'others', label: 'Others', desc: 'Others from your district' },
  ];
  const GROUP_LABEL = { men: 'men', women: 'women', others: 'others' };
  const INTEREST_TAGS = ['music', 'travel', 'movies', 'sports', 'gaming', 'cooking', 'reading', 'fitness', 'art', 'tech', 'photography', 'nature'];
  const genderLabel = (g) => (GENDERS.find((x) => x.value === g) || {}).label || '';

  function choiceGroup(name, options, current, onChange) {
    return h('div', { class: 'choices' }, options.map((o) => {
      const input = h('input', { type: 'radio', name, value: o.value, checked: current === o.value });
      input.addEventListener('change', () => onChange(o.value));
      return h('label', { class: 'choice' }, input, h('span', { class: 'choice-body' }, h('strong', {}, o.label), o.desc ? h('small', {}, o.desc) : null));
    }));
  }

  function chipPicker(selected, max = 8) {
    const box = h('div', { class: 'chips' });
    [...new Set([...INTEREST_TAGS, ...selected])].forEach((tag) => {
      const b = h('button', { type: 'button', class: 'chip' + (selected.includes(tag) ? ' active' : '') }, tag);
      b.addEventListener('click', () => {
        const i = selected.indexOf(tag);
        if (i >= 0) { selected.splice(i, 1); b.classList.remove('active'); }
        else if (selected.length >= max) toast(`You can pick up to ${max}.`);
        else { selected.push(tag); b.classList.add('active'); }
      });
      box.append(b);
    });
    return box;
  }

  function ageOf(dateStr) {
    const b = new Date(dateStr + 'T00:00:00'); if (isNaN(b)) return null;
    const n = new Date(); let a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
    return a;
  }

  /* ---------- place picker: type a few letters, click the exact "District, State" ---------- */
  const normText = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  let placesPromise;
  function loadPlaces() {
    if (!placesPromise) {
      placesPromise = api('/places').then((r) => r.places.map((p) => ({ ...p, keys: [p.district, ...p.aliases].map(normText), hay: normText([p.district, p.state, ...p.aliases].join(' ')) })))
        .catch((e) => { placesPromise = null; throw e; });
    }
    return placesPromise;
  }

  // Finds districts by their name, old name or city name ("bangalore", "bang kar", "mysore", "vizag"...).
  function matchPlaces(list, query) {
    const q = normText(query); if (!q) return [];
    const tokens = q.split(' '), q0 = tokens[0];
    const found = [];
    for (const p of list) {
      if (!tokens.every((t) => p.hay.includes(t))) continue;
      let score = 30;
      if (p.keys.includes(q)) score = 100;
      else if (p.keys.includes(q0)) score = 95;
      else if (p.keys.some((k) => k.startsWith(q))) score = 90;
      else if (p.keys.some((k) => k.startsWith(q0))) score = 80;
      else if (p.keys.some((k) => k.split(' ').some((w) => w.startsWith(q0)))) score = 60;
      const shortest = Math.min(...p.keys.filter((k) => k.startsWith(q0)).map((k) => k.length), 999);
      found.push({ p, score, shortest });
    }
    found.sort((a, b) => b.score - a.score || a.shortest - b.shortest || a.p.label.localeCompare(b.p.label));
    return found.slice(0, 8).map((x) => x.p);
  }

  // The only way to set a place: it must be clicked from the list, so it can never be misspelled.
  function placePicker({ initial, onPick }) {
    let chosen = initial ? { id: initial.id, label: initial.label } : null;
    let items = [], active = -1;
    const input = h('input', { type: 'text', autocomplete: 'off', placeholder: 'Start typing, e.g. Bangalore', role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', value: chosen ? chosen.label : '' });
    const list = h('ul', { class: 'place-list', role: 'listbox', hidden: true });
    const wrap = h('div', { class: 'place' + (chosen ? ' picked' : '') }, input, list);
    const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); };
    const pick = (p) => { chosen = { id: p.id, label: p.label }; input.value = p.label; wrap.classList.add('picked'); close(); onPick(chosen); };
    const paintActive = () => $$('.place-item', list).forEach((li, i) => li.classList.toggle('active', i === active));
    async function render() {
      const text = input.value.trim();
      if (!text) return close();
      let all; try { all = await loadPlaces(); } catch { return; }
      if (input.value.trim() !== text) return; // a newer keystroke is already being handled
      items = matchPlaces(all, text);
      const q0 = normText(text).split(' ')[0];
      list.replaceChildren(...(items.length
        ? items.map((p, i) => {
            const alias = !normText(p.district).startsWith(q0) ? p.aliases.find((a) => normText(a).startsWith(q0)) : null;
            return h('li', { class: 'place-item', role: 'option', onMousedown: (e) => { e.preventDefault(); pick(p); } },
              h('strong', {}, p.district), h('span', { class: 'muted' }, ', ' + p.state), alias ? h('small', { class: 'muted' }, ` · also "${alias}"`) : null);
          })
        : [h('li', { class: 'place-empty muted' }, 'No match. Check the spelling or try the nearest big city.')]));
      active = -1; list.hidden = false; input.setAttribute('aria-expanded', 'true');
    }
    input.addEventListener('input', () => { if (chosen) { chosen = null; wrap.classList.remove('picked'); onPick(null); } render(); });
    input.addEventListener('focus', () => { if (!chosen) render(); });
    input.addEventListener('blur', () => setTimeout(close, 120));
    input.addEventListener('keydown', (e) => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; paintActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; paintActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(items[active >= 0 ? active : 0]); }
      else if (e.key === 'Escape') close();
    });
    return h('div', { class: 'field' },
      h('div', { class: 'field-label' }, 'Your district'),
      wrap,
      h('div', { class: 'muted place-hint' }, 'Type and pick from the list, for example "Bangalore, Karnataka".'));
  }

  /* ---------- confirm email (code sent at sign-up / login) ---------- */
  const vs = { mode: 'confirm', pending: '' }; // confirm | change-form | change-code

  // Accounts without a phone number (older accounts, Google sign-ups) must add one before going on.
  function startPhoneGate() {
    $('#app-view').hidden = true; $('#onboarding-view').hidden = true; $('#verify-view').hidden = false;
    $('#verify-card').replaceChildren(
      h('h2', {}, 'Add your phone number'),
      h('p', { class: 'muted' }, 'Your phone number is a way to log in and to get your account back. We will text you a code to confirm it.'),
      phoneAddFlow(() => startApp(state.me, true)),
      h('div', { class: 'row between' }, h('span'), h('button', { class: 'link', type: 'button', onClick: logout }, 'Log out')));
  }

  function startVerify() {
    $('#app-view').hidden = true; $('#onboarding-view').hidden = true; $('#verify-view').hidden = false;
    vs.mode = 'confirm'; vs.pending = '';
    renderVerify();
    // send the code right away; if one was sent a moment ago the server just says so
    api('/account/email/confirm/send', { method: 'POST' }).catch((e) => { if (e.status !== 429) toast(e.message); });
  }

  function renderVerify() {
    const card = $('#verify-card');
    const link = (text, fn) => h('button', { class: 'link', type: 'button', onClick: fn }, text);
    if (vs.mode === 'change-form') {
      const err = h('p', { class: 'error' });
      const form = h('form', { class: 'form' },
        h('h2', {}, 'Use a different email'),
        h('p', { class: 'muted' }, 'Enter the correct address. We will send a new code there.'),
        labelInput('Email address', 'newEmail', { type: 'email', required: true, autocomplete: 'email' }),
        passwordBox(), err,
        h('button', { class: 'btn primary', type: 'submit' }, 'Send code'),
        link('Back', () => { vs.mode = 'confirm'; renderVerify(); }));
      onSubmit(form, err, async (f) => {
        await api('/account/email/send', { method: 'POST', body: { newEmail: f.newEmail, currentPassword: f.currentPassword } });
        vs.pending = f.newEmail.trim().toLowerCase(); vs.mode = 'change-code'; renderVerify();
      });
      return card.replaceChildren(form);
    }
    const changing = vs.mode === 'change-code';
    const address = changing ? vs.pending : state.me.email;
    card.replaceChildren(
      h('h2', {}, 'Check your email'),
      codeStep({
        message: h('span', {}, 'We sent a 6-digit code to ', h('strong', {}, address), changing ? '.' : '. Is that the right address? If not, you can change it below.'),
        onResend: () => (changing
          ? api('/account/email/send', { method: 'POST', body: { newEmail: vs.pending } })
          : api('/account/email/confirm/send', { method: 'POST' })),
        onVerify: async (code) => {
          const { user } = await api(changing ? '/account/email/verify' : '/account/email/confirm', { method: 'POST', body: changing ? { newEmail: vs.pending, code } : { code } });
          state.me = cache(user); toast('Email confirmed');
          startApp(user, true);
        },
      }),
      h('div', { class: 'row between' }, link('Wrong email? Change it', () => { vs.mode = 'change-form'; renderVerify(); }), link('Log out', logout)));
  }

  /* ---------- shared form pieces for phone/email ---------- */
  const labelInput = (label, name, attrs = {}) => h('label', {}, label, h('input', { name, ...attrs }));
  // The password box only appears when the login is older than 15 minutes (or the server asked for it).
  const passwordBox = () => (state.me.hasPassword && !tokenRecent()
    ? labelInput('Current password', 'currentPassword', { type: 'password', autocomplete: 'current-password', required: true }) : null);

  // A member without a password who logged in a while ago must confirm it is really them with a code.
  const needsReauth = () => state.config.codesRequired && !state.me.hasPassword && !tokenRecent();
  function reauthPrompt(onDone) {
    const body = h('div'); const err = h('p', { class: 'error' });
    const form = h('form', { class: 'form' },
      h('p', { class: 'muted' }, 'For your security, we send a code to your phone (or email) to confirm it is you.'),
      err, h('button', { class: 'btn primary', type: 'submit' }, 'Send me a code'));
    onSubmit(form, err, async () => {
      const first = await api('/account/reauth/send', { method: 'POST' });
      body.replaceChildren(codeStep({
        message: `We sent a 6-digit code to your ${first.channel === 'sms' ? 'phone' : 'email'}.`,
        onResend: () => api('/account/reauth/send', { method: 'POST' }),
        onVerify: async (code) => {
          const r = await api('/account/reauth/verify', { method: 'POST', body: { code } });
          setToken(r.token); state.me = cache(r.user); toast('Thanks, you are confirmed.'); onDone();
        },
      }));
    });
    body.append(form);
    return body;
  }

  // Enter the (new) number -> we text a code to THAT number -> enter code -> number saved. Used for adding and changing.
  function phoneAddFlow(onDone, label = 'Phone number (with country code)') {
    const body = h('div');
    const draw = () => body.replaceChildren(needsReauth() ? reauthPrompt(draw) : phoneForm());
    function phoneForm() {
      const holder = h('div'); const err = h('p', { class: 'error' });
      const form = h('form', { class: 'form' },
        labelInput(label, 'phone', { type: 'tel', placeholder: '+91 98765 43210', required: true, autocomplete: 'tel' }),
        passwordBox(), err, h('button', { class: 'btn primary', type: 'submit' }, 'Send code'));
      onSubmit(form, err, async (f) => {
        const send = () => api('/account/phone/send', { method: 'POST', body: { phone: f.phone, currentPassword: f.currentPassword } });
        await send();
        holder.replaceChildren(codeStep({
          message: `We sent a 6-digit code to ${f.phone}.`, onResend: send,
          onVerify: async (code) => {
            const { user } = await api('/account/phone/verify', { method: 'POST', body: { phone: f.phone, code } });
            state.me = cache(user); toast('Phone number saved'); onDone();
          },
        }));
      });
      holder.append(form);
      return holder;
    }
    draw();
    return body;
  }

  /* ---------- onboarding (shown once, right after sign-up) ---------- */
  const ob = { step: 1, dir: 1, data: {} };

  function startOnboarding() {
    ob.step = 1; ob.dir = 1;
    ob.total = 3; // the phone is collected (and verified) before setup starts
    const m = state.me;
    ob.data = {
      birthDate: m.birthDate || '', gender: m.gender || null,
      placeId: m.place ? m.place.id : '', placeLabel: m.place ? m.place.label : '',
      interestedIn: INTERESTED_IN.some((o) => o.value === m.interestedIn) ? m.interestedIn : null,
      bio: m.bio || '', interests: [...(m.interests || [])],
    };
    $('#app-view').hidden = true; $('#onboarding-view').hidden = false;
    $('#ob-card').replaceChildren(
      h('div', { class: 'progress' }, h('div', { class: 'progress-bar', id: 'ob-bar' })),
      h('p', { class: 'muted', id: 'ob-label' }),
      h('div', { id: 'ob-step' }),
      h('p', { class: 'error', id: 'ob-error' }),
      h('div', { class: 'row between' },
        h('button', { class: 'btn', id: 'ob-back', type: 'button', onClick: () => obMove(-1) }, 'Back'),
        h('button', { class: 'btn primary', id: 'ob-next', type: 'button', onClick: obNext }, 'Continue')));
    renderOnboarding();
  }

  function renderOnboarding() {
    const d = ob.data;
    const maxBirth = new Date(); maxBirth.setFullYear(maxBirth.getFullYear() - 18);
    const minBirth = new Date(); minBirth.setFullYear(minBirth.getFullYear() - 100);
    const iso = (x) => x.toISOString().slice(0, 10);
    let body;
    if (ob.step === 1) {
      const dob = h('input', { type: 'date', value: d.birthDate, min: iso(minBirth), max: iso(maxBirth), required: true });
      dob.addEventListener('input', () => { d.birthDate = dob.value; });
      const where = placePicker({ initial: d.placeId ? { id: d.placeId, label: d.placeLabel } : null, onPick: (c) => { d.placeId = c ? c.id : ''; d.placeLabel = c ? c.label : ''; } });
      body = [
        h('h2', {}, `Welcome, ${state.me.displayName.split(' ')[0]}!`),
        h('p', { class: 'muted' }, 'Tell us a little about yourself. This takes under a minute.'),
        h('label', {}, 'Date of birth (you must be 18 or older)', dob),
        where,
        h('div', { class: 'field-label' }, 'I am'),
        choiceGroup('gender', GENDERS, d.gender, (v) => { d.gender = v; }),
      ];
    } else if (ob.step === 2) {
      body = [
        h('h2', {}, 'Who would you like to meet?'),
        h('p', { class: 'muted' }, 'You will see people of this group from your district, get suggestions, and can chat with them. You can change it any time.'),
        choiceGroup('interestedIn', INTERESTED_IN, d.interestedIn, (v) => { d.interestedIn = v; }),
      ];
    } else if (ob.step === 4) {
      body = [
        h('h2', {}, 'Keep your account safe'),
        h('p', { class: 'muted' }, 'Add your phone number so we can text you a code if you ever forget your password. Other members never see it.'),
        phoneAddFlow(() => startApp(state.me, true)),
      ];
    } else {
      const bio = h('textarea', { rows: 3, maxlength: 200, placeholder: 'A line or two about you' }, d.bio);
      bio.addEventListener('input', () => { d.bio = bio.value; });
      body = [
        h('h2', {}, 'Almost done'),
        h('p', { class: 'muted' }, 'Add a short bio and pick what you enjoy. We use interests to suggest people you will click with.'),
        avatarEditor(),
        h('label', {}, 'About you (optional)', bio),
        h('div', { class: 'field-label' }, 'Interests (pick up to 8)'),
        chipPicker(d.interests, 8),
      ];
    }
    $('#ob-step').replaceChildren(h('div', { class: 'step' + (ob.dir < 0 ? ' back' : '') }, body));
    $('#ob-bar').style.width = (ob.step / ob.total) * 100 + '%';
    $('#ob-label').textContent = `Step ${ob.step} of ${ob.total}`;
    $('#ob-error').textContent = '';
    $('#ob-back').style.visibility = ob.step === 1 || ob.step === 4 ? 'hidden' : 'visible';
    $('#ob-next').textContent = ob.step === 4 ? 'Skip for now' : ob.step === 3 && ob.total === 3 ? 'Finish' : 'Continue';
  }

  function obMove(dir) { ob.step += dir; ob.dir = dir; renderOnboarding(); }

  async function obNext() {
    const d = ob.data, err = $('#ob-error');
    if (ob.step === 4) return startApp(state.me, true); // skipped the phone for now
    if (ob.step === 1) {
      const age = d.birthDate ? ageOf(d.birthDate) : null;
      if (age === null) return (err.textContent = 'Please enter your date of birth.');
      if (age < 18) return (err.textContent = 'You must be at least 18 years old to use Connectly.');
      if (!d.placeId) return (err.textContent = 'Please choose your district from the list.');
      if (!d.gender) return (err.textContent = 'Please choose one option for "I am".');
      return obMove(1);
    }
    if (ob.step === 2) {
      if (!d.interestedIn) return (err.textContent = 'Please choose who you would like to meet.');
      return obMove(1);
    }
    const btn = $('#ob-next'); btn.disabled = true;
    try {
      const { user } = await api('/me', { method: 'PUT', body: d });
      state.me = cache(user);
      if (ob.total === 4) { ob.step = 4; ob.dir = 1; renderOnboarding(); } else startApp(user, true);
    } catch (e) { err.textContent = e.message; }
    finally { btn.disabled = false; }
  }

  function renderMeBar() {
    $('#me-avatar').replaceChildren(avatar(state.me, 38));
    $('#me-name').textContent = state.me.displayName;
    $('#me-username').textContent = '@' + state.me.username;
  }

  /* ---------- sidebar ---------- */
  function setTabUI(tab) {
    state.tab = tab;
    $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    renderFilter();
  }
  function setTab(tab) {
    setTabUI(tab);
    if (tab === 'chats') loadConversations(true); else runSearch();
  }
  $$('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // "Show me: Men / Women / Others  in: My district / All <state>" quick switches
  function filterRow() {
    const place = state.me.place;
    return [h('span', { class: 'muted' }, 'Show me'), ...filterChips(), h('span', { class: 'muted filter-gap' }, 'in'), ...scopeChips(place)];
  }
  const scopeChips = (place) => [['district', place ? place.district : 'My district'], ['state', place ? 'All ' + place.state : 'My state']].map(([v, label]) =>
    h('button', { type: 'button', class: 'chip' + (state.scope === v ? ' active' : ''), onClick: () => setScope(v) }, label));
  function refreshFilters() {
    const hf = $('#home-filter'); if (hf) hf.replaceChildren(...filterRow());
    renderFilter();
  }
  function renderFilter() {
    const f = $('#filter');
    f.hidden = state.tab !== 'discover';
    if (f.hidden || !state.me) return;
    f.replaceChildren(...filterRow());
  }
  function setScope(scope) {
    if (state.scope === scope) return;
    state.scope = scope; localStorage.setItem('scope', scope); state.feed = null;
    refreshFilters(); runSearch();
    if (state.view === 'home') loadFeed();
  }
  const filterChips = () => INTERESTED_IN.map((o) => h('button', { type: 'button', class: 'chip' + (state.me.interestedIn === o.value ? ' active' : ''), onClick: () => setInterest(o.value) }, o.label));
  async function setInterest(value) {
    if (state.me.interestedIn === value) return;
    try {
      const { user } = await api('/me', { method: 'PUT', body: { interestedIn: value } });
      state.me = cache(user); state.feed = null; refreshFilters(); runSearch();
      if (state.view === 'home') loadFeed();
    } catch (e) { toast(e.message); }
  }

  let searchTimer, searchSeq = 0;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (state.tab !== 'discover') setTabUI('discover');
    searchTimer = setTimeout(runSearch, 250);
  });

  async function runSearch() {
    const seq = ++searchSeq;
    try {
      const q = $('#search').value.trim();
      const { users } = await api(q ? `/users/search?scope=${state.scope}&q=${encodeURIComponent(q)}` : `/users/suggestions?scope=${state.scope}`);
      if (seq !== searchSeq) return;
      state.peopleQuery = q;
      state.people = users.map((u) => ({ ...cache(u), reasons: u.reasons || [] }));
      if (state.tab === 'discover') renderList(true);
    } catch (e) { toast(e.message); }
  }

  async function loadConversations(animate = false) {
    try {
      const { conversations } = await api('/conversations');
      conversations.forEach((c) => cache(c.user));
      state.conversations = conversations;
      renderList(animate); updateUnread();
    } catch (e) { toast(e.message); }
  }

  function renderList(animate = false) {
    const list = $('#list');
    list.replaceChildren();
    const cls = (extra) => 'item' + (extra ? ' ' + extra : '') + (animate ? ' enter' : '');
    const delay = (li, i) => { if (animate) li.style.animationDelay = Math.min(i, 12) * 25 + 'ms'; return li; };
    if (state.tab === 'chats') {
      if (!state.conversations.length) list.append(h('li', { class: 'empty' }, 'No chats yet. Open Discover to find someone to talk to.'));
      state.conversations.forEach((c, i) => {
        const mine = c.lastMessage.senderId === state.me.id;
        list.append(delay(h('li', { class: cls(state.activeId === c.user.id && state.view === 'chat' ? 'active' : ''), onClick: () => openChat(c.user.id) },
          avatar(c.user, 44, true),
          h('div', { class: 'item-text' }, h('strong', {}, c.user.displayName), h('span', {}, (mine ? 'You: ' : '') + c.lastMessage.body)),
          c.unread ? h('span', { class: 'badge' }, c.unread) : null), i));
      });
    } else {
      list.append(h('li', { class: 'list-title' }, state.peopleQuery ? 'Results' : 'Suggested for you'));
      if (!state.people.length) {
        const group = GROUP_LABEL[state.me.interestedIn] || 'people';
        list.append(h('li', { class: 'empty' }, state.peopleQuery ? 'No one found with that name.' : `No ${group} here yet. Check back soon or try another option above.`));
      }
      state.people.forEach((u, i) => {
        const sub = u.reasons && u.reasons.length ? u.reasons.join(' · ') : ((u.place ? u.place.label : '@' + u.username));
        list.append(delay(h('li', { class: cls(state.activeId === u.id && state.view === 'profile' ? 'active' : ''), onClick: () => openProfile(u.id) },
          avatar(u, 44, true),
          h('div', { class: 'item-text' }, h('strong', {}, u.displayName + (u.age ? ', ' + u.age : '')), h('span', {}, sub))), i));
      });
    }
  }

  function updateUnread() {
    const n = state.conversations.reduce((s, c) => s + c.unread, 0);
    const b = $('#unread-badge');
    b.hidden = !n; b.textContent = n;
    document.title = n ? `(${n}) Connectly` : 'Connectly';
  }

  function refreshPresence() {
    $$('.avatar-wrap[data-uid]').forEach((w) => $('.dot', w).classList.toggle('on', state.online.has(Number(w.dataset.uid))));
    $$('[data-status]').forEach((s) => { s.textContent = statusText(Number(s.dataset.status)); });
  }

  /* ---------- main panel ---------- */
  function showMain(on) { $('#app-view').classList.toggle('show-main', on); }
  function goHome() { state.view = 'home'; state.activeId = null; showMain(false); renderMain(); renderList(); }
  // Home = the personalised feed (on phones it opens the main area instead of the sidebar)
  $('#btn-home').addEventListener('click', () => { state.view = 'home'; state.activeId = null; showMain(true); renderMain(); renderList(); });
  $('#btn-edit-profile').addEventListener('click', () => { state.view = 'edit'; state.activeId = null; showMain(true); renderMain(); renderList(); });

  function renderMain() {
    const main = $('#main');
    main.replaceChildren();
    if (state.view === 'profile') return renderProfile(main);
    if (state.view === 'chat') return renderChat(main);
    if (state.view === 'edit') return renderEdit(main);
    renderHome(main);
  }

  /* ---------- home feed ---------- */
  let feedSeq = 0;

  function renderHome(main) {
    main.append(h('div', { class: 'home' },
      h('div', { class: 'home-head' },
        h('div', {}, h('h2', {}, `Hi, ${state.me.displayName.split(' ')[0]}`), h('p', { class: 'muted', id: 'home-sub' }, 'Finding people for you…')),
        h('div', { class: 'row left', style: 'margin:0' },
          h('button', { class: 'btn small', type: 'button', onClick: () => { loadFeed(); } }, 'Refresh'),
          h('button', { class: 'btn small mobile-only', type: 'button', onClick: goHome }, 'Chats & search'))),
      recoveryBanner(),
      photoBanner(),
      h('div', { class: 'filter', id: 'home-filter' }, ...filterRow()),
      h('div', { id: 'feed-body' })));
    if (state.feed) renderFeed(state.feed);
    else $('#feed-body').replaceChildren(h('div', { class: 'grid' }, [1, 2, 3, 4, 5, 6].map(() => h('div', { class: 'card skeleton' }))));
    loadFeed();
  }

  function recoveryBanner() {
    if (!state.config.codesRequired || !state.config.smsEnabled || state.me.phone || sessionStorage.getItem('hideRecoveryBanner')) return null;
    const el = h('div', { class: 'banner' },
      h('span', {}, 'Add a phone number so you can get your account back if you ever forget your password.'),
      h('button', { class: 'btn small primary', type: 'button', onClick: () => { state.view = 'edit'; state.settingsTab = 'security'; state.activeId = null; showMain(true); renderMain(); renderList(); } }, 'Add phone'),
      h('button', { class: 'btn small', type: 'button', onClick: () => { sessionStorage.setItem('hideRecoveryBanner', '1'); el.remove(); } }, 'Not now'));
    return el;
  }

  async function loadFeed() {
    const seq = ++feedSeq;
    try {
      const feed = await api('/feed?scope=' + state.scope);
      if (seq !== feedSeq || state.view !== 'home') return;
      [...feed.online, ...feed.suggested, ...feed.newMembers].forEach((u) => cache(u));
      state.feed = feed; renderFeed(feed);
    } catch (e) {
      const b = $('#feed-body'); if (b && state.view === 'home') b.replaceChildren(h('div', { class: 'empty-feed' }, e.message));
    }
  }

  function renderFeed(feed) {
    const body = $('#feed-body'); if (!body) return;
    const group = GROUP_LABEL[state.me.interestedIn] || 'people';
    const place = state.me.place;
    const area = place ? (feed.scope === 'state' ? place.state : place.district) : 'your area';
    $('#home-sub').textContent = feed.counts.total
      ? `${feed.counts.total} ${group} in ${area} · ${feed.counts.online} online now`
      : `No ${group} in ${area} yet`;
    if (!feed.counts.total) {
      const invite = h('button', { class: 'btn' + (feed.scope === 'state' || !place ? ' primary' : ''), type: 'button', onClick: () => { navigator.clipboard?.writeText(location.origin); toast('Link copied. Share it with friends!'); } }, 'Copy invite link');
      return body.replaceChildren(h('div', { class: 'empty-feed' },
        h('strong', {}, `No ${group} in ${area} yet`),
        h('span', {}, feed.scope === 'district' && place
          ? `Nobody from ${place.district} has joined yet. You can look across all of ${place.state}, or invite friends.`
          : 'You are among the first! Invite friends so there is someone to talk to.'),
        feed.scope === 'district' && place ? h('button', { class: 'btn primary', type: 'button', onClick: () => setScope('state') }, `Show all of ${place.state}`) : null,
        invite));
    }
    const out = [];
    if (feed.online.length) out.push(h('h3', {}, 'Online now'), h('div', { class: 'strip' }, feed.online.map((u, i) => miniCard(u, i))));
    if (feed.suggested.length) out.push(h('h3', {}, 'Suggested for you'), h('div', { class: 'grid' }, feed.suggested.map((u, i) => profileCard(u, i))));
    if (feed.newMembers.length) out.push(h('h3', {}, 'New members'), h('div', { class: 'grid' }, feed.newMembers.map((u, i) => profileCard(u, i))));
    body.replaceChildren(...out);
  }

  function miniCard(u, i) {
    const el = h('div', { class: 'mini', onClick: () => openProfile(u.id) }, avatar(u, 56, true), h('span', {}, u.displayName.split(' ')[0]));
    el.style.animationDelay = Math.min(i, 10) * 30 + 'ms';
    return el;
  }

  function profileCard(u, i) {
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    const el = h('div', { class: 'card', onClick: () => openProfile(u.id) },
      h('div', { class: 'card-top' }, avatar(u, 60, true),
        h('div', { class: 'card-id' }, h('strong', {}, u.displayName + (u.age ? ', ' + u.age : '')), h('span', { class: 'muted' }, (u.place ? (state.scope === 'state' ? u.place.label : u.place.district) : '@' + u.username)))),
      u.reasons && u.reasons.length ? h('div', { class: 'reasons' }, u.reasons.join(' · ')) : null,
      u.interests && u.interests.length ? h('div', { class: 'chips' }, u.interests.slice(0, 3).map((t) => h('span', { class: 'chip static' }, t))) : null,
      h('div', { class: 'row left' },
        h('button', { class: 'btn small primary', type: 'button', onClick: stop(() => openChat(u.id)) }, 'Message'),
        h('button', { class: 'btn small', type: 'button', onClick: stop(() => openProfile(u.id)) }, 'View profile')));
    el.style.animationDelay = Math.min(i, 10) * 30 + 'ms';
    return el;
  }

  /* ---------- profile pictures, photos and videos ---------- */
  const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
  const media = {}; // member id -> promise of { photos, videos }

  function checkFile(file, kind) {
    const mb = 1024 * 1024;
    if (kind === 'video') {
      if (file.type && !VIDEO_TYPES.includes(file.type)) return 'Use an MP4, MOV or WebM video.';
      if (file.size > 50 * mb) return 'Videos can be up to 50 MB.';
    } else {
      if (file.type && !IMAGE_TYPES.includes(file.type)) return 'Use a JPEG, PNG, WebP or GIF picture.';
      if (file.size > 10 * mb) return 'Pictures can be up to 10 MB.';
    }
    return null;
  }

  // XMLHttpRequest instead of fetch so we can show upload progress for big videos.
  function uploadFile(path, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api' + path);
      xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(Object.assign(new Error(data.error || 'The upload failed.'), { status: xhr.status }));
      };
      xhr.onerror = () => reject(new Error('Network problem while uploading. Please try again.'));
      const fd = new FormData(); fd.append('file', file); xhr.send(fd);
    });
  }

  function loadMedia(id) {
    if (!media[id]) media[id] = api('/users/' + id + '/media').catch((e) => { delete media[id]; throw e; });
    return media[id];
  }

  // Profile picture: shown big, with Change / Remove. Used in setup and in Settings.
  function avatarEditor() {
    const box = h('div', { class: 'avatar-editor' });
    const err = h('p', { class: 'error' }); const status = h('small', { class: 'muted' });
    const input = h('input', { type: 'file', accept: IMAGE_TYPES.join(','), hidden: true });
    async function remove() {
      try { const { user } = await api('/me/avatar', { method: 'DELETE' }); state.me = cache(user); renderMeBar(); paint(); }
      catch (e) { err.textContent = e.message; }
    }
    function paint() {
      box.replaceChildren(avatar(state.me, 96),
        h('div', { class: 'avatar-actions' },
          h('button', { class: 'btn small', type: 'button', onClick: () => input.click() }, state.me.avatarUrl ? 'Change photo' : 'Add a profile photo'),
          state.me.avatarUrl ? h('button', { class: 'btn small', type: 'button', onClick: remove }, 'Remove') : null,
          h('small', { class: 'muted' }, 'JPEG, PNG, WebP or GIF, up to 10 MB'), status, err),
        input);
    }
    input.addEventListener('change', async () => {
      const f = input.files[0]; input.value = ''; err.textContent = '';
      if (!f) return;
      const bad = checkFile(f, 'photo'); if (bad) { err.textContent = bad; return; }
      try {
        status.textContent = 'Uploading… 0%';
        const { user } = await uploadFile('/me/avatar', f, (p) => { status.textContent = `Uploading… ${p}%`; });
        state.me = cache(user); renderMeBar(); state.feed = null; paint();
      } catch (e) { status.textContent = ''; err.textContent = e.message; }
    });
    paint();
    return box;
  }

  function openLightbox(items, start) {
    let i = start;
    const img = h('img', { class: 'lb-img', alt: '' });
    const count = h('div', { class: 'lb-count' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const show = (n) => { i = (n + items.length) % items.length; img.src = items[i].url; count.textContent = items.length > 1 ? `${i + 1} / ${items.length}` : ''; };
    const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') show(i + 1); else if (e.key === 'ArrowLeft') show(i - 1); };
    const nav = (cls, label, d) => (items.length > 1 ? h('button', { class: 'lb-nav ' + cls, type: 'button', 'aria-label': label, onClick: (e) => { e.stopPropagation(); show(i + d); } }, d < 0 ? '‹' : '›') : null);
    const overlay = h('div', { class: 'lightbox', onClick: (e) => { if (e.target === overlay) close(); } },
      img, count, h('button', { class: 'lb-close', type: 'button', 'aria-label': 'Close', onClick: close }, '✕'), nav('prev', 'Previous', -1), nav('next', 'Next', 1));
    document.body.append(overlay); document.addEventListener('keydown', onKey); show(start);
  }

  const photoGrid = (list) => h('div', { class: 'media-grid' }, list.map((p, i) =>
    h('button', { class: 'media-thumb', type: 'button', onClick: () => openLightbox(list, i) }, h('img', { src: p.thumb, alt: 'Photo', loading: 'lazy' }))));
  const videoPlayer = (v) => h('video', { src: v.url + '#t=0.1', controls: true, preload: 'metadata', playsinline: true });

  /* ---------- another member's profile: Profile / Photos / Videos / Chat ---------- */
  async function openProfile(id) {
    try {
      const { user, online, counts } = await api('/users/' + id);
      cache({ ...user, counts }); if (online) state.online.add(id);
      state.profileTab = 'about';
      state.view = 'profile'; state.activeId = id; showMain(true); renderMain(); renderList();
    } catch (e) { toast(e.message); }
  }

  const chatIcon = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); const path = document.createElementNS(ns, 'path');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z');
    svg.append(path); return svg;
  };

  function renderProfile(main) {
    const u = state.users[state.activeId];
    const counts = u.counts || { photos: 0, videos: 0 };
    const tab = state.profileTab || 'about';
    const details = [u.age ? u.age + ' years' : null, genderLabel(u.gender), u.place ? u.place.label : null].filter(Boolean).join(' · ');
    const interestedLabel = (INTERESTED_IN.find((o) => o.value === u.interestedIn) || {}).label;

    const hero = h('div', { class: 'profile-hero' },
      h('div', { class: 'avatar-wrap', 'data-uid': u.id, title: u.avatarUrl ? 'View photo' : null, onClick: u.avatarUrl ? () => openLightbox([{ url: u.avatarUrl }], 0) : null },
        avatar(u, 120), h('span', { class: 'dot' + (state.online.has(u.id) ? ' on' : '') })),
      h('div', { class: 'hero-text' },
        h('h2', {}, u.displayName + (u.age ? ', ' + u.age : '')),
        h('div', { class: 'muted' }, '@' + u.username),
        details ? h('div', {}, details) : null,
        h('div', { class: 'muted', 'data-status': u.id }, statusText(u.id))));

    const tabButton = (key, label) => h('button', { type: 'button', class: tab === key ? 'active' : '', onClick: () => { state.profileTab = key; renderMain(); } }, label);
    const tabs = h('div', { class: 'tabs profile-tabs' },
      tabButton('about', 'Profile'), tabButton('photos', `Photos (${counts.photos})`), tabButton('videos', `Videos (${counts.videos})`),
      h('button', { type: 'button', class: 'chat-tab', onClick: () => openChat(u.id) }, chatIcon(), ' Chat'));

    let body;
    if (tab === 'about') {
      const row = (k, v) => (v ? h('div', { class: 'kv' }, h('span', { class: 'muted' }, k), h('span', {}, v)) : null);
      body = h('div', { class: 'sec-card' },
        h('p', { class: 'bio' }, u.bio || 'No bio yet.'),
        row('I am', genderLabel(u.gender)), row('Interested in', interestedLabel), row('Lives in', u.place ? u.place.label : ''),
        row('Joined', new Date(u.createdAt).toLocaleDateString([], { month: 'long', year: 'numeric' })),
        u.interests && u.interests.length ? h('div', { class: 'chips' }, u.interests.map((t) => h('span', { class: 'chip static' }, t))) : null);
    } else {
      const kind = tab === 'photos' ? 'photo' : 'video';
      body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
      const id = u.id;
      loadMedia(id).then((m) => {
        const list = kind === 'photo' ? m.photos : m.videos;
        body.replaceChildren(list.length
          ? (kind === 'photo' ? photoGrid(list) : h('div', { class: 'video-grid' }, list.map((v) => h('div', { class: 'video-card' }, videoPlayer(v)))))
          : h('div', { class: 'empty-feed' }, `${u.displayName.split(' ')[0]} has not added any ${kind}s yet.`));
      }).catch((e) => body.replaceChildren(h('p', { class: 'error' }, e.message)));
    }

    main.append(h('div', { class: 'chat-head' }, h('button', { class: 'btn small back', onClick: goHome }, '← Back'), h('strong', {}, 'Profile')));
    main.append(h('div', { class: 'profile-page' }, hero, tabs, h('div', { class: 'profile-body' }, body)));
  }

  /* ---------- my photos and videos (Settings) ---------- */
  function mediaCard(kind) {
    const isPhoto = kind === 'photo', max = isPhoto ? 12 : 4;
    const grid = h('div', { class: isPhoto ? 'media-grid' : 'video-grid' });
    const counter = h('span', { class: 'muted' }); const err = h('p', { class: 'error' }); const status = h('small', { class: 'muted' });
    const input = h('input', { type: 'file', accept: (isPhoto ? IMAGE_TYPES : VIDEO_TYPES).join(','), multiple: true, hidden: true });
    const add = h('button', { class: 'btn primary', type: 'button', onClick: () => input.click() }, isPhoto ? 'Add photos' : 'Add videos');

    async function refresh() {
      delete media[state.me.id];
      let m; try { m = await loadMedia(state.me.id); } catch (e) { err.textContent = e.message; return; }
      const items = isPhoto ? m.photos : m.videos;
      counter.textContent = `${items.length} of ${max}`; add.disabled = items.length >= max;
      grid.replaceChildren(...(items.length ? items.map((it, i) => h('div', { class: 'media-tile' },
        isPhoto ? h('button', { class: 'media-thumb', type: 'button', onClick: () => openLightbox(items, i) }, h('img', { src: it.thumb, alt: 'Photo', loading: 'lazy' })) : videoPlayer(it),
        h('button', { class: 'tile-del', type: 'button', 'aria-label': 'Delete', onClick: async () => {
          if (!confirm(`Delete this ${kind}?`)) return;
          try { await api('/me/media/' + it.id, { method: 'DELETE' }); refresh(); } catch (e) { err.textContent = e.message; }
        } }, '✕')))
        : [h('p', { class: 'muted' }, `No ${kind}s yet.`)]));
    }

    input.addEventListener('change', async () => {
      const chosen = [...input.files]; input.value = ''; err.textContent = '';
      let done = 0; add.disabled = true;
      for (const f of chosen) {
        const bad = checkFile(f, kind); if (bad) { err.textContent = `${f.name}: ${bad}`; continue; }
        try {
          const label = (p) => { status.textContent = `Uploading ${f.name} (${done + 1} of ${chosen.length})… ${p}%`; };
          label(0); await uploadFile('/me/media?kind=' + kind, f, label); done++;
        } catch (e) { err.textContent = `${f.name}: ${e.message}`; break; }
      }
      status.textContent = done ? `${done} added.` : ''; await refresh();
    });

    refresh();
    return h('section', { class: 'sec-card' },
      h('h3', {}, isPhoto ? 'Photos' : 'Videos'),
      h('p', { class: 'muted' }, isPhoto ? 'Up to 12 photos (JPEG, PNG, WebP or GIF, 10 MB each). Other members see them on your profile.' : 'Up to 4 videos (MP4, MOV or WebM, 50 MB each). MP4 plays everywhere.'),
      counter, grid, status, err, add, input);
  }
  const mediaPanel = () => h('div', { style: 'display:grid;gap:14px' }, mediaCard('photo'), mediaCard('video'));

  // gentle nudge on the home page
  function photoBanner() {
    if (state.me.avatarUrl || sessionStorage.getItem('hidePhotoBanner')) return null;
    const el = h('div', { class: 'banner' },
      h('span', {}, 'Add a profile photo so people recognise you. Profiles with photos get more messages.'),
      h('button', { class: 'btn small primary', type: 'button', onClick: () => { state.view = 'edit'; state.settingsTab = 'profile'; state.activeId = null; showMain(true); renderMain(); renderList(); } }, 'Add photo'),
      h('button', { class: 'btn small', type: 'button', onClick: () => { sessionStorage.setItem('hidePhotoBanner', '1'); el.remove(); } }, 'Not now'));
    return el;
  }

  function renderEdit(main) {
    const tab = state.settingsTab || 'profile';
    const tabs = h('div', { class: 'tabs settings-tabs' },
      ...[['profile', 'Profile'], ['media', 'Photos & videos'], ['security', 'Account & security']].map(([k, label]) =>
        h('button', { type: 'button', class: tab === k ? 'active' : '', onClick: () => { state.settingsTab = k; renderMain(); } }, label)));
    main.append(
      h('div', { class: 'chat-head' }, h('button', { class: 'btn small back', onClick: goHome }, '← Back'), h('strong', {}, 'Settings')),
      h('div', { class: 'settings' }, tabs, tab === 'security' ? securityPanel() : tab === 'media' ? mediaPanel() : profileForm()));
  }

  function onSubmit(form, errEl, fn) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); errEl.textContent = '';
      const btn = $('button[type=submit]', form); if (btn) btn.disabled = true;
      try { await fn(Object.fromEntries(new FormData(form))); }
      catch (err) {
        errEl.textContent = err.message;
        if (err.code === 'password_required') { state.recentUntil = 0; errEl.textContent = 'For your security, please open this again and type your current password.'; }
      }
      finally { if (btn) btn.disabled = false; }
    });
  }

  function profileForm() {
    const draft = { gender: state.me.gender, interestedIn: state.me.interestedIn, placeId: state.me.place ? state.me.place.id : '', interests: [...(state.me.interests || [])] };
    const err = h('p', { class: 'error', id: 'edit-error' });
    const form = h('form', { class: 'form sec-card' },
      h('h3', {}, 'My profile'),
      avatarEditor(),
      h('label', {}, 'Name', h('input', { name: 'displayName', value: state.me.displayName, maxlength: 40, required: true })),
      placePicker({ initial: state.me.place, onPick: (c) => { draft.placeId = c ? c.id : ''; } }),
      h('label', {}, 'Bio', h('textarea', { name: 'bio', rows: 3, maxlength: 200 }, state.me.bio || '')),
      h('div', { class: 'field-label' }, 'I am'),
      choiceGroup('gender', GENDERS, draft.gender, (v) => { draft.gender = v; }),
      h('div', { class: 'field-label' }, 'I want to meet'),
      choiceGroup('interestedIn', INTERESTED_IN, draft.interestedIn, (v) => { draft.interestedIn = v; }),
      h('div', { class: 'field-label' }, 'Interests (up to 8)'),
      chipPicker(draft.interests, 8),
      err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Save'));
    onSubmit(form, err, async (f) => {
      if (!draft.placeId) throw new Error('Please choose your district from the list.');
      const { user } = await api('/me', { method: 'PUT', body: { displayName: f.displayName, placeId: draft.placeId, bio: f.bio, gender: draft.gender, interestedIn: draft.interestedIn, interests: draft.interests } });
      state.me = cache(user); state.feed = null; renderMeBar(); refreshFilters(); runSearch(); toast('Profile saved');
    });
    return form;
  }

  // After a password change the server issues a fresh token and signs every other device out.
  function applyNewSession({ token, user }) {
    setToken(token);
    state.me = cache(user); connectSocket();
  }

  function codeStep({ message, onVerify, onResend }) {
    const err = h('p', { class: 'error' });
    const input = h('input', { name: 'code', inputmode: 'numeric', maxlength: 7, autocomplete: 'one-time-code', placeholder: '123456', required: true, class: 'code-input' });
    const resend = h('button', { class: 'btn small', type: 'button' });
    const form = h('form', { class: 'form' }, h('p', { class: 'muted' }, message), h('label', {}, '6-digit code', input), err,
      h('button', { class: 'btn primary', type: 'submit' }, 'Verify'), resend);
    let left = 60;
    const tick = () => { resend.disabled = left > 0; resend.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code'; };
    tick();
    const timer = setInterval(() => { if (!form.isConnected) return clearInterval(timer); if (left > 0) { left--; tick(); } }, 1000);
    resend.addEventListener('click', async () => {
      try { await onResend(); left = 60; tick(); toast('New code sent'); } catch (e) { err.textContent = e.message; }
    });
    onSubmit(form, err, (f) => onVerify(f.code));
    return form;
  }

  function securityPanel() {
    const me = state.me, cfg = state.config;
    const card = (title, desc, ...kids) => h('section', { class: 'sec-card' }, h('h3', {}, title), desc ? h('p', { class: 'muted' }, desc) : null, ...kids);
    const field = (label, name, attrs = {}) => h('label', {}, label, h('input', { name, ...attrs }));
    const pwField = () => (me.hasPassword ? field('Current password', 'currentPassword', { type: 'password', autocomplete: 'current-password', required: true }) : null);
    const kv = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'muted' }, k), h('span', {}, v));
    const cards = [];

    cards.push(card('How you sign in', null,
      kv('Phone number', me.phone || 'Not added'),
      kv('Email', me.email),
      kv('Password', me.hasPassword ? 'Set' : 'Not set (you log in with codes)'),
      kv('Google', me.googleLinked ? 'Connected' : 'Not connected')));

    // password
    { const err = h('p', { class: 'error' });
      const form = h('form', { class: 'form' }, pwField(),
        field('New password (min 8 characters)', 'newPassword', { type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
        field('Repeat new password', 'repeat', { type: 'password', minlength: 8, required: true, autocomplete: 'new-password' }),
        err, h('button', { class: 'btn primary', type: 'submit' }, me.hasPassword ? 'Change password' : 'Create password'));
      onSubmit(form, err, async (f) => {
        if (f.newPassword !== f.repeat) throw new Error('The two new passwords do not match.');
        applyNewSession(await api('/account/password', { method: 'POST', body: { currentPassword: f.currentPassword, newPassword: f.newPassword } }));
        toast('Password updated. Your other devices were signed out.'); renderMain();
      });
      cards.push(card(me.hasPassword ? 'Change password' : 'Create a password (optional)', me.hasPassword ? 'Changing it signs you out on all your other devices.' : 'You log in with codes. If you would also like a password, create one here.', !me.hasPassword && needsReauth() ? reauthPrompt(() => renderMain()) : form)); }

    // phone number: it can be changed (never removed); the NEW number is confirmed with a code
    if (cfg.codesRequired && cfg.smsEnabled) {
      cards.push(card('Phone number',
        me.phone ? `Your number is ${me.phone}. It is also a way to log in. To change it, enter the new number: we text it a code, and the number changes once you enter that code.` : 'Add your phone number. We text it a code to confirm it.',
        phoneAddFlow(() => renderMain(), me.phone ? 'New phone number (with country code)' : 'Phone number (with country code)')));
    }

    if (cfg.codesRequired) {
    // email: the NEW address is confirmed with a code before it replaces the old one
    { const body = h('div');
      const draw = () => body.replaceChildren(needsReauth() ? reauthPrompt(draw) : emailForm());
      const emailForm = () => {
        const holder = h('div'); const err = h('p', { class: 'error' });
        const form = h('form', { class: 'form' }, field('New email address', 'newEmail', { type: 'email', required: true, autocomplete: 'email' }), passwordBox(), err, h('button', { class: 'btn primary', type: 'submit' }, 'Send code'));
        onSubmit(form, err, async (f) => {
          const send = () => api('/account/email/send', { method: 'POST', body: { newEmail: f.newEmail, currentPassword: f.currentPassword } });
          await send();
          holder.replaceChildren(codeStep({
            message: `We sent a 6-digit code to ${f.newEmail}.`, onResend: send,
            onVerify: async (code) => { const { user } = await api('/account/email/verify', { method: 'POST', body: { newEmail: f.newEmail, code } }); state.me = cache(user); toast('Email updated'); renderMain(); },
          }));
        });
        holder.append(form);
        return holder;
      };
      draw();
      cards.push(card('Email address', `Your email is ${me.email}. To change it, enter the new address: we send it a code, and the email changes once you enter that code.`, body)); }

    }

    // while codes are switched off: change the phone number / email directly (the password is needed)
    if (!cfg.codesRequired) {
      const direct = (title, desc, field, label, attrs) => {
        const err = h('p', { class: 'error' });
        const form = h('form', { class: 'form' },
          labelInput(label, field, { required: true, ...attrs }),
          me.hasPassword ? labelInput('Current password', 'currentPassword', { type: 'password', required: true, autocomplete: 'current-password' }) : null,
          err, h('button', { class: 'btn primary', type: 'submit' }, 'Save'));
        onSubmit(form, err, async (f) => {
          try {
            const { user } = await api('/account/contact', { method: 'PUT', body: { [field]: f[field], currentPassword: f.currentPassword } });
            state.me = cache(user); toast('Saved'); renderMain();
          } catch (ex) { throw Object.assign(ex, { message: (ex.fields && ex.fields[field]) || ex.message }); }
        });
        return card(title, desc, form);
      };
      cards.push(direct('Phone number', `Your number is ${me.phone || 'not set'}. Enter a new number to change it.`, 'phone', 'New phone number (with country code)', { type: 'tel', placeholder: '+91 98765 43210', autocomplete: 'tel' }));
      cards.push(direct('Email address', `Your email is ${me.email}. Enter a new address to change it.`, 'email', 'New email address', { type: 'email', autocomplete: 'email' }));
    }

    // sessions
    cards.push(card('Devices', 'Signed in somewhere you no longer use? Sign out everywhere except this device.',
      h('button', { class: 'btn', type: 'button', onClick: async () => {
        if (!confirm('Sign out of all other devices?')) return;
        try { applyNewSession(await api('/account/logout-all', { method: 'POST' })); toast('Signed out everywhere else'); } catch (e) { toast(e.message); }
      } }, 'Log out of all other devices')));

    // delete
    { const err = h('p', { class: 'error' });
      const form = h('form', { class: 'form' }, field(`Type your username (${me.username}) to confirm`, 'confirm', { required: true, autocomplete: 'off' }), pwField(), err, h('button', { class: 'btn danger', type: 'submit' }, 'Delete my account'));
      onSubmit(form, err, async (f) => {
        if (!confirm('This permanently deletes your profile and all your messages. This cannot be undone. Continue?')) return;
        await api('/account', { method: 'DELETE', body: { confirm: f.confirm, currentPassword: f.currentPassword } });
        toast('Your account was deleted.'); logout();
      });
      const zone = card('Delete account', 'This permanently removes your profile and messages.', !me.hasPassword && needsReauth() ? reauthPrompt(() => renderMain()) : form); zone.classList.add('danger-zone'); cards.push(zone); }

    return h('div', { class: 'settings-stack', style: 'display:grid;gap:14px' }, cards);
  }

  /* ---------- chat ---------- */
  async function openChat(id) {
    try {
      if (!state.users[id]) cache((await api('/users/' + id)).user);
      const { messages, hasMore } = await api('/messages/' + id);
      Object.assign(state, { view: 'chat', activeId: id, messages, hasMore, lastDay: null });
      state.msgEls.clear();
      showMain(true); renderMain();
      markRead(id); renderList();
    } catch (e) { toast(e.message); }
  }

  function renderChat(main) {
    const u = state.users[state.activeId];
    const msgs = h('div', { class: 'msgs', id: 'msgs' });
    const input = h('textarea', { id: 'msg-input', rows: 1, maxlength: 2000, placeholder: 'Type a message…' });
    const form = h('form', { class: 'composer' }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Send'));

    main.append(
      h('div', { class: 'chat-head' },
        h('button', { class: 'btn small back', onClick: goHome, type: 'button' }, '← Back'),
        avatar(u, 40, true),
        h('div', { class: 'who', onClick: () => openProfile(u.id) }, h('strong', {}, u.displayName), h('span', { 'data-status': u.id }, statusText(u.id))),
        h('button', { class: 'btn small', type: 'button', onClick: () => startCall(u, 'audio') }, 'Voice call'),
        h('button', { class: 'btn small', type: 'button', onClick: () => startCall(u, 'video') }, 'Video call')),
      msgs,
      h('div', { class: 'typing', id: 'typing' }),
      form);

    if (state.hasMore) msgs.append(loadMoreButton());
    state.messages.forEach((m) => appendMessage(m, false));
    msgs.scrollTop = msgs.scrollHeight;

    form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
    input.addEventListener('input', () => {
      input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      if (!state.typingSent) { state.typingSent = true; state.socket.emit('typing', { to: u.id, isTyping: true }); }
      clearTimeout(state.typingTimer);
      state.typingTimer = setTimeout(() => { state.typingSent = false; state.socket.emit('typing', { to: u.id, isTyping: false }); }, 1800);
    });
    input.focus();
  }

  function loadMoreButton() {
    return h('button', { class: 'btn small load-more', type: 'button', onClick: async (e) => {
      const first = state.messages[0]; if (!first) return;
      try {
        const { messages, hasMore } = await api(`/messages/${state.activeId}?before=${first.id}`);
        state.messages = [...messages, ...state.messages]; state.hasMore = hasMore;
        const box = $('#msgs'), prevH = box.scrollHeight;
        box.replaceChildren(); state.msgEls.clear(); state.lastDay = null;
        if (hasMore) box.append(loadMoreButton());
        state.messages.forEach((m) => appendMessage(m, false));
        box.scrollTop = box.scrollHeight - prevH;
      } catch (err) { toast(err.message); }
    } }, 'Load earlier messages');
  }

  function appendMessage(m, scroll = true) {
    const box = $('#msgs'); if (!box) return;
    const day = new Date(m.createdAt).toDateString();
    if (day !== state.lastDay) { box.append(h('div', { class: 'day' }, fmtDay(m.createdAt))); state.lastDay = day; }
    const mine = m.senderId === state.me.id;
    const meta = h('span', { class: 'meta' }, fmtTime(m.createdAt) + (mine ? (m.readAt ? ' ✓✓' : ' ✓') : ''));
    if (mine) state.msgEls.set(m.id, meta);
    box.append(h('div', { class: 'bubble' + (mine ? ' me' : '') }, m.body, meta));
    if (scroll) box.scrollTop = box.scrollHeight;
  }

  function sendMessage() {
    const input = $('#msg-input'); const body = input.value.trim();
    if (!body) return;
    clearTimeout(state.typingTimer);
    if (state.typingSent) { state.typingSent = false; state.socket.emit('typing', { to: state.activeId, isTyping: false }); }
    state.socket.emit('message:send', { to: state.activeId, body }, (res) => { if (res?.error) toast(res.error); });
    input.value = ''; input.style.height = 'auto';
  }

  const markRead = (id) => api(`/messages/${id}/read`, { method: 'POST' }).then(() => loadConversations()).catch(() => {});

  function onNewMessage(m) {
    const peerId = m.senderId === state.me.id ? m.receiverId : m.senderId;
    const inChat = state.view === 'chat' && state.activeId === peerId;
    if (inChat) {
      state.messages.push(m); appendMessage(m);
      if (m.senderId !== state.me.id) markRead(peerId);
    }
    if (!state.users[peerId]) api('/users/' + peerId).then((r) => { cache(r.user); loadConversations(); }).catch(() => {});
    else loadConversations();
    if (!inChat && m.senderId !== state.me.id) toast(`${state.users[peerId]?.displayName || 'New message'}: ${m.body.slice(0, 60)}`);
  }

  /* ---------- socket ---------- */
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    const s = io({ auth: (cb) => cb({ token: state.token }) });
    state.socket = s;
    s.on('presence:list', (ids) => { state.online = new Set(ids); refreshPresence(); });
    s.on('presence', ({ userId, online, lastSeen }) => {
      online ? state.online.add(userId) : state.online.delete(userId);
      if (lastSeen && state.users[userId]) state.users[userId].lastSeen = lastSeen;
      refreshPresence();
    });
    s.on('message:new', onNewMessage);
    s.on('message:read', ({ by }) => {
      for (const m of state.messages) if (m.senderId === state.me.id && m.receiverId === by && !m.readAt) {
        m.readAt = new Date().toISOString();
        const el = state.msgEls.get(m.id); if (el) el.textContent = fmtTime(m.createdAt) + ' ✓✓';
      }
    });
    s.on('typing', ({ from, isTyping }) => {
      const el = $('#typing');
      if (el && state.view === 'chat' && state.activeId === from) el.textContent = isTyping ? `${state.users[from]?.displayName || 'They'} is typing…` : '';
    });
    s.on('connect_error', (err) => { if (err.message === 'unauthorized') logout(); });

    s.on('call:incoming', onIncomingCall);
    s.on('call:accepted', onCallAccepted);
    s.on('call:rejected', () => { toast('Call declined'); endCall(false); });
    s.on('call:ended', () => { if (state.incoming) { toast('Missed call'); hideIncoming(); } else if (state.call) { toast('Call ended'); endCall(false); } });
    s.on('call:handled', hideIncoming);
    s.on('call:signal', onSignal);
  }

  /* ---------- calls (WebRTC) ---------- */
  async function getMedia(type) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need HTTPS (or localhost) and a supported browser.');
    try { return await navigator.mediaDevices.getUserMedia({ audio: true, video: type === 'video' }); }
    catch { throw new Error(type === 'video' ? 'Could not access your camera/microphone. Check browser permissions.' : 'Could not access your microphone. Check browser permissions.'); }
  }

  function showCallUI(peer, type) {
    const c = $('#call');
    c.classList.toggle('audio', type === 'audio');
    $('#call-name').textContent = peer.displayName;
    $('#call-avatar').replaceChildren(avatar(peer, 120));
    $('#local-video').srcObject = state.call.stream;
    $('#remote-video').srcObject = null;
    $('#btn-cam').hidden = type !== 'video';
    $('#btn-mute').textContent = 'Mute'; $('#btn-cam').textContent = 'Camera off';
    setCallStatus('Calling…');
    c.hidden = false;
  }
  const setCallStatus = (t) => { $('#call-status').textContent = t; };

  async function startCall(peer, type) {
    if (state.call || state.incoming) return toast('You are already in a call.');
    try {
      const stream = await getMedia(type);
      state.call = { peer, type, role: 'caller', stream, pc: null, pendingIce: [], ringTimer: null, timer: null };
      showCallUI(peer, type);
      state.socket.emit('call:invite', { to: peer.id, type }, (res) => {
        if (res?.error) { toast(res.error); endCall(false); }
      });
      state.call.ringTimer = setTimeout(() => { toast('No answer'); endCall(true); }, 45000);
    } catch (e) { toast(e.message); }
  }

  function onIncomingCall({ from, type }) {
    cache(from);
    if (state.call || state.incoming) return;
    state.incoming = { from, type };
    $('#incoming-avatar').replaceChildren(avatar(from, 80));
    $('#incoming-name').textContent = from.displayName;
    $('#incoming-type').textContent = type === 'video' ? 'Incoming video call' : 'Incoming voice call';
    $('#incoming').hidden = false;
  }
  function hideIncoming() { state.incoming = null; $('#incoming').hidden = true; }

  $('#btn-decline').addEventListener('click', () => {
    if (!state.incoming) return;
    state.socket.emit('call:reject', { from: state.incoming.from.id });
    hideIncoming();
  });

  $('#btn-accept').addEventListener('click', async () => {
    const inc = state.incoming; if (!inc) return;
    try {
      const stream = await getMedia(inc.type);
      hideIncoming();
      state.call = { peer: inc.from, type: inc.type, role: 'callee', stream, pc: null, pendingIce: [], ringTimer: null, timer: null };
      showCallUI(inc.from, inc.type);
      setCallStatus('Connecting…');
      createPeerConnection();
      state.socket.emit('call:accept', { from: inc.from.id });
    } catch (e) {
      toast(e.message);
      state.socket.emit('call:reject', { from: inc.from.id });
      hideIncoming();
    }
  });

  function createPeerConnection() {
    const call = state.call;
    const pc = new RTCPeerConnection({ iceServers: state.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }] });
    call.pc = pc;
    call.stream.getTracks().forEach((t) => pc.addTrack(t, call.stream));
    pc.onicecandidate = (e) => { if (e.candidate) state.socket.emit('call:signal', { to: call.peer.id, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => { $('#remote-video').srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') startCallTimer();
      else if (pc.connectionState === 'failed') { toast('Connection lost'); endCall(true); }
      else if (pc.connectionState === 'disconnected') setCallStatus('Reconnecting…');
    };
    return pc;
  }

  async function onCallAccepted() {
    const call = state.call;
    if (!call || call.role !== 'caller' || call.pc) return;
    clearTimeout(call.ringTimer);
    setCallStatus('Connecting…');
    const pc = createPeerConnection();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit('call:signal', { to: call.peer.id, data: { sdp: pc.localDescription } });
  }

  async function onSignal({ from, data }) {
    const call = state.call;
    if (!call || !call.pc || call.peer.id !== from) return;
    const pc = call.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        for (const c of call.pendingIce.splice(0)) await pc.addIceCandidate(c);
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          state.socket.emit('call:signal', { to: from, data: { sdp: pc.localDescription } });
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
        else call.pendingIce.push(data.candidate);
      }
    } catch (e) { console.error('signal error', e); }
  }

  function startCallTimer() {
    const call = state.call; if (!call || call.timer) return;
    const t0 = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      setCallStatus(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
    };
    tick(); call.timer = setInterval(tick, 1000);
  }

  function endCall(notify) {
    const call = state.call; if (!call) return;
    if (notify) state.socket.emit('call:end', { to: call.peer.id });
    clearTimeout(call.ringTimer); clearInterval(call.timer);
    call.pc?.close();
    call.stream.getTracks().forEach((t) => t.stop());
    $('#local-video').srcObject = null; $('#remote-video').srcObject = null;
    $('#call').hidden = true;
    state.call = null;
  }

  $('#btn-hangup').addEventListener('click', () => endCall(true));
  $('#btn-mute').addEventListener('click', (e) => {
    const track = state.call?.stream.getAudioTracks()[0]; if (!track) return;
    track.enabled = !track.enabled; e.target.textContent = track.enabled ? 'Mute' : 'Unmute';
  });
  $('#btn-cam').addEventListener('click', (e) => {
    const track = state.call?.stream.getVideoTracks()[0]; if (!track) return;
    track.enabled = !track.enabled; e.target.textContent = track.enabled ? 'Camera off' : 'Camera on';
  });
  window.addEventListener('beforeunload', () => { if (state.call) state.socket.emit('call:end', { to: state.call.peer.id }); });

  boot();
})();
