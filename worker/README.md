# Grandstand 后端（Cloudflare Worker）

账号、预测排行榜、赛后评分和推送通知都在这一个 Worker 里，数据存在 Cloudflare D1。
数据表和推送密钥都由 Worker 第一次运行时自己建好，不需要手动跑 SQL，也不需要生成或粘贴任何密钥。

## 部署（全部在 Cloudflare 网页后台操作）

1. **建 Worker**
   左侧菜单「Compute (Workers)」→「Workers & Pages」→「Create」→「Create Worker」（Hello World 模板即可），
   名字填 `grandstand-api`，点「Deploy」。

2. **粘贴代码**
   部署完点「Edit code」，把编辑器里的内容全部删掉，粘贴本目录下 `worker.js` 的全部内容，点右上角「Deploy」。

3. **建数据库**
   左侧菜单「Storage & Databases」→「D1 SQL Database」→「Create」，名字填 `grandstand`，点「Create」。

4. **把数据库接到 Worker**
   回到 `grandstand-api` → 「Bindings」→「Add binding」→ 选「D1 database」，
   Variable name 填 **`DB`**（必须是大写的 DB），Database 选 `grandstand`，保存。

5. **每分钟检查一次比分**
   `grandstand-api` →「Settings」→「Trigger events」→「Add」→「Cron Triggers」，
   选「Every minute」（即 `* * * * *`），保存。

6. **（建议）推送联系方式**
   「Settings」→「Variables and Secrets」→「Add」，类型 Text，名字 `VAPID_SUBJECT`，
   值填 `mailto:你的邮箱`。推送服务在出问题时会用它联系你；不填也能用。

7. **（可选）找回密码的邮件**
   不配的话一切照常，只是登录框下面不出现「忘记密码？」。需要一个发邮件的服务，推荐 Brevo（免费，每天 300 封，不需要自己的域名）：
   1. 在 brevo.com 注册账号。
   2. 在「Senders」里添加一个发件人，填你自己的邮箱，然后点 Brevo 发到这个邮箱的验证链接。
   3. 在「SMTP & API」→「API Keys」里生成一个 API key。
   4. 回到 Worker 的「Settings」→「Variables and Secrets」，加两个变量：
      - `BREVO_KEY`，类型选 **Secret**，值是刚生成的 API key；
      - `MAIL_FROM`，类型 Text，值是第 2 步验证过的发件邮箱。

   如果你有自己的域名，也可以用 Resend：变量换成 `RESEND_KEY`（Secret）和 `MAIL_FROM`（这个域名下的地址）。
   用 Gmail 之类的免费邮箱当发件人，邮件可能会进收件人的垃圾箱，这是免费邮箱的限制。

8. **自检**
   浏览器打开 `https://grandstand-api.<你的子域名>.workers.dev/api/health`，会看到类似：
   ```
   {"ok":true,"cron":{"ok":true,"last":"2026-09-26T08:00:00.000Z","agoSec":21,"ms":180,"pushes":0,"settled":0},
    "espn":{"site":"403","siteWeb":"200 ok",...},"sources":{"lol":"200 ok","pages":"200 ok"},
    "mail":{"via":"brevo"},"users":1,"subs":1}
   ```
   - `cron`：每分钟的检查最后一次跑的时间。`ok` 是 `false`、或 `agoSec` 超过 180，说明定时任务停了，去「Settings」→「Trigger events」看看 Cron 还在不在；有 `error` 的话把它发给我。
   - `espn` 列出 ESPN 的四个地址在 Cloudflare 上能不能用。Worker 用的是 `siteWeb`
     （`site.web.api.espn.com`），它是 `200 ok`，比分推送和服务器结算就能用。
     `site`（`site.api.espn.com`）会拒绝 Cloudflare 的请求，返回 403 是正常的。
   - `sources`：结算英雄联盟（`lol`）和 CS2 / Valorant（`pages`，网站自己的数据文件）用的地址。
   - `mail`：找回密码走哪家（`off` 就是没配）。发信失败时会多一个 `lastError`。

把这个地址发给我，我填进 app 里（`index.html` 的 `API_BASE`），这些功能就会出现在 app 上。

## 用量

免费版够用：每天 10 万次请求、每次请求 10 毫秒 CPU，D1 每天 500 万次读取。
每分钟的检查只请求有人关注的联赛，一天大约 1440 次触发。

密码用 PBKDF2-SHA256 加盐存储。为了放进免费版的 10 毫秒 CPU 限额，迭代次数是 1 万次；
换成付费版后，可以加一个变量 `PBKDF2_ITER` 调高，旧密码不受影响（每条记录存了自己的次数）。

## 账号安全

- 同一个邮箱连续输错 5 次密码，这个邮箱锁 15 分钟；同一个网络 15 分钟内输错 30 次，也锁 15 分钟。锁的时候不算密码，所以刷不动服务器。
- 同一个网络每小时最多注册 5 个号；同一个邮箱每小时最多发 3 封找回密码的邮件。
- 登录 30 天不用会自动失效，用着就一直有效。重设密码后，所有设备上的旧登录都会退出。
- 找回密码的链接 30 分钟内有效、只能用一次，数据库里只存它的哈希。

## 服务器结算

足球、NBA 查 ESPN 的比赛结果；F1 领奖台查 ESPN 正赛前三（按车手姓氏比对）；英雄联盟查 LoL 官方赛程接口；
CS2 和 Valorant 查网站自己发布的 `data/cs2.json`、`data/valorant.json`。
不管 app 报的是什么，都以这些结果为准，开赛后才提交的预测判为不中。其他项目（UFC、拳击）按 app 报的结果。

## 开发和测试

- `test.html`：用本地服务器打开，会在浏览器里跑整个 Worker（数据库换成 sql.js，ESPN 和推送服务是假的），
  覆盖注册登录、预测、排行榜、评分、推送加密解密、每分钟的开赛/进球/完场推送、服务器结算（足球、F1、英雄联盟、CS2）、
  定时任务心跳、登录限流、登录过期、找回密码。
- `dev-api.js`：在 app 页面里跑一个本地 Worker，不用部署就能试界面：
  ```js
  localStorage.setItem('apiBase', JSON.stringify('https://api.test')); location.reload();
  await import('/worker/dev-api.js');
  ```
  用完删掉 `apiBase`：`localStorage.removeItem('apiBase')`。
  想试找回密码：`devApi.env.RESEND_KEY = 'dev'`，邮件不会真的发出去，会放在 `devApi.mails` 里。
