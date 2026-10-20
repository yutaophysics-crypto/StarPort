'use strict';

(() => {
  const $ = id => document.getElementById(id);
  let mode = 'login';
  let csrf = '';
  let user = null;

  const params = new URL(location.href).searchParams;
  let audience = params.get('server');
  let nonce = params.get('nonce');

  try {
    if (audience) {
      const url = new URL(audience);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
        !/^[A-Za-z0-9_-]{43}$/.test(nonce || '')
      ) {
        throw Error();
      }
      audience = url.origin;
    }
  } catch {
    audience = null;
    nonce = null;
    $('error').textContent = '群聊登录地址无效，请从星港重新打开。';
  }

  async function api(action, method = 'GET', body) {
    const response = await fetch('/account/api/' + action, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(csrf ? { 'X-Starport-CSRF': csrf } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '账号中心暂时不可用');
    return data;
  }

  function show(auth) {
    user = auth.user;
    csrf = auth.csrf;
    $('auth').hidden = true;
    $('signed').hidden = false;
    $('identity').textContent = user.name + '（' + user.username + '）';
    $('destination').textContent = audience
      ? '将以此账号进入群聊服务器：' + audience
      : '已登录星港账号。你可以回到星港加入群聊。';
    $('continue').hidden = !audience;
    $('password').value = '';
    $('error').textContent = '';
  }

  function switchMode(next) {
    mode = next;
    $('name-field').hidden = mode !== 'register';
    $('name').required = mode === 'register';
    $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('password').value = '';
    $('submit').textContent = mode === 'register' ? '创建账号' : '登录';
    $('login').setAttribute('aria-pressed', String(mode === 'login'));
    $('register').setAttribute('aria-pressed', String(mode === 'register'));
  }

  $('login').onclick = () => switchMode('login');
  $('register').onclick = () => switchMode('register');

  $('form').onsubmit = async event => {
    event.preventDefault();
    $('submit').disabled = true;
    $('error').textContent = '';
    try {
      show(
        await api(mode, 'POST', {
          username: $('username').value,
          password: $('password').value,
          name: $('name').value
        })
      );
    } catch (e) {
      $('error').textContent = e.message;
    } finally {
      $('password').value = '';
      $('submit').disabled = false;
    }
  };

  $('continue').onclick = async () => {
    if (!audience) return;
    $('continue').disabled = true;
    try {
      const result = await api('grant', 'POST', { audience, nonce });
      location.replace(audience + '/#accountGrant=' + encodeURIComponent(result.grant));
    } catch (e) {
      $('error').textContent = e.message;
      $('continue').disabled = false;
    }
  };

  $('logout').onclick = async () => {
    try {
      await api('logout', 'POST', {});
      user = null;
      csrf = '';
      $('signed').hidden = true;
      $('auth').hidden = false;
    } catch (e) {
      $('error').textContent = e.message;
    }
  };

  api('session')
    .then(show)
    .catch(() => {});
})();
