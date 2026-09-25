/* Development only: runs worker.js inside the app's own page, against an
   in-memory SQLite, so the account, calls, leaderboard and ratings can be
   tried without deploying anything. Point the app at it and load this in
   the page's console:

     localStorage.setItem('apiBase', JSON.stringify('https://api.test')); location.reload();
     // then:
     await import('/worker/dev-api.js');

   Everything is lost on reload, and nothing here is used by the live site.
   To try the password reset, turn mail on; mails land in devApi.mails:

     devApi.env.RESEND_KEY = 'dev';
*/
await new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/sql-wasm.js';
  s.onload = res; s.onerror = rej;
  document.head.appendChild(s);
});
const SQL = await window.initSqlJs({ locateFile: (f) => 'https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/' + f });
const db = new SQL.Database();
function exec(sql, args) {
  const st = db.prepare(sql);
  st.bind(args.map((a) => (a === undefined ? null : a)));
  const rows = [];
  while (st.step()) rows.push(st.getAsObject());
  st.free();
  return rows;
}
const DB = {
  prepare(sql) {
    const s = { args: [] };
    s.bind = (...a) => { s.args = a; return s; };
    s.all = async () => ({ results: exec(sql, s.args) });
    s.first = async () => exec(sql, s.args)[0] || null;
    s.run = async () => { exec(sql, s.args); return { meta: { last_row_id: db.exec('SELECT last_insert_rowid()')[0].values[0][0] } }; };
    return s;
  },
  async batch(list) { for (const x of list) await x.run(); }
};
const src = await (await fetch('/worker/worker.js?' + Date.now())).text();
const W = (await import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))).default;
const realFetch = window.fetch.bind(window);
const calls = [], mails = [];
const env = { DB };
window.fetch = async (url, opts = {}) => {
  const u = String((url && url.url) || url);
  if (u.startsWith('https://api.resend.com/')) { mails.push(JSON.parse(opts.body)); return new Response('{"id":"dev"}'); }
  if (!u.startsWith('https://api.test')) return realFetch(url, opts);
  calls.push((opts.method || 'GET') + ' ' + u.slice('https://api.test'.length));
  const req = new Request(u, {
    method: opts.method || 'GET',
    headers: Object.assign({ Origin: location.origin }, opts.headers),
    body: opts.body
  });
  return W.fetch(req, env, { waitUntil() {} });
};
// an account left over from an earlier session means nothing to this database
localStorage.removeItem('acct');
window.devApi = { db, calls, mails, worker: W, env };
export default window.devApi;
