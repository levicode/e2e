/**
 * A tiny stand-in for the UAT app, used only by `test/loop-check.ts` to prove
 * the loop's mechanics on this machine without touching the real environment.
 *
 * It has the same shape the scenario expects — an auth redirect, a two-level
 * menu (账号管理 → 账号标签管理), the `#/account_label` route with the account ID
 * field, and the app's own account query endpoint — plus a "scan" page that
 * completes the sign-in by itself, so the login step can run unattended here.
 * It serves nothing private and exists only in this checkout.
 */
import { createServer } from 'node:http';

const app = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>UAT fixture</title></head>
<body>
  <nav><button id="account-menu" type="button">账号管理</button>
    <ul id="submenu" hidden><li><a id="label-link" href="#/account_label">账号标签管理</a></li></ul>
  </nav>
  <main id="view">首页</main>
  <script>
    if (!document.cookie.split('; ').includes('uat_session=ok')) {
      location.replace('/login.html?redirect=' + encodeURIComponent(location.href));
    } else {
      const render = () => {
        const view = document.getElementById('view');
        if (location.hash === '#/account_label') {
          view.innerHTML = '<h1>账号标签管理</h1>' +
            '<input placeholder="请输入账号ID">' +
            '<button id="search" type="button">查询</button>' +
            '<table><tbody id="rows"></tbody></table>';
          document.getElementById('search').addEventListener('click', async () => {
            const accountId = document.querySelector('input').value;
            const response = await fetch('/web_api/v1/account/label/query_account?account_id=' + encodeURIComponent(accountId));
            const body = await response.json();
            document.getElementById('rows').innerHTML = body.result.data
              .map(row => '<tr><td>' + row.account_id + '</td></tr>').join('');
          });
        } else {
          view.textContent = '首页';
        }
      };
      document.getElementById('account-menu').addEventListener('click', () => {
        const submenu = document.getElementById('submenu');
        submenu.hidden = !submenu.hidden;
      });
      window.addEventListener('hashchange', render);
      render();
      if (location.hash === '' || location.hash === '#/') location.hash = '#/home';
    }
  </script>
</body>
</html>`;

const login = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>UAT fixture login</title></head>
<body>
  <p>扫码登录（fixture：自动完成）</p>
  <script>
    const params = new URLSearchParams(location.search);
    const redirect = params.get('redirect') || '/app/';
    // hold=1 is the page a signed-out app redirects to: it waits for a scan
    // that never comes, so the loop check can prove the login-redirect verdict.
    if (params.get('hold') !== '1') {
      setTimeout(() => {
        document.cookie = 'uat_session=ok; path=/; max-age=3600';
        location.replace(redirect);
      }, 300);
    }
  </script>
</body>
</html>`;

/** The app page, whatever path served it; `/flaky/` reuses it once its gateway recovers. */
function sendApp(response) {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(app);
}

/** A gateway page, not the app: what a 5xx looks like to the setup. */
function sendGateway(response, status = 504) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<html><body>${status} Gateway Time-out</body></html>`);
}

// `/flaky/` answers its first request with a 504 and the app after that, so the
// loop check can prove the bounded setup retry on a real browser.
let flakyFailuresLeft = 1;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/app' || url.pathname === '/app/') {
    sendApp(response);
    return;
  }
  if (url.pathname === '/flaky/' || url.pathname === '/flaky') {
    if (flakyFailuresLeft > 0) {
      flakyFailuresLeft -= 1;
      sendGateway(response);
      return;
    }
    sendApp(response);
    return;
  }
  if (url.pathname === '/down/' || url.pathname === '/down') {
    sendGateway(response, 503);
    return;
  }
  if (url.pathname === '/signed-out/' || url.pathname === '/signed-out') {
    // The app's own "the session is gone" answer: a cross-origin redirect to the
    // SSO page, where the login window is left open (no auto scan here).
    const port = server.address().port;
    const loginPage = new URL(`http://localhost:${port}/login.html`);
    loginPage.searchParams.set('hold', '1');
    loginPage.searchParams.set('redirect', `http://127.0.0.1:${port}/app/`);
    response.writeHead(302, { location: loginPage.toString() });
    response.end();
    return;
  }
  if (url.pathname === '/login.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(login);
    return;
  }
  if (url.pathname === '/web_api/v1/account/label/query_account') {
    const accountId = url.searchParams.get('account_id') ?? '';
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({
      code: 0,
      result: { data: accountId === '' ? [] : [{ account_id: accountId, account_name: 'fixture' }], total_count: accountId === '' ? 0 : 1 },
    }));
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

server.listen(Number(process.argv[2] ?? '0'), '127.0.0.1', () => {
  console.log(`LISTEN ${server.address().port}`);
});
