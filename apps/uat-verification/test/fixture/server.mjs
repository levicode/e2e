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
    const redirect = new URLSearchParams(location.search).get('redirect') || '/app/';
    setTimeout(() => {
      document.cookie = 'uat_session=ok; path=/; max-age=3600';
      location.replace(redirect);
    }, 300);
  </script>
</body>
</html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/app' || url.pathname === '/app/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(app);
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
