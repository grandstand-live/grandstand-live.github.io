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

7. **自检**
   浏览器打开 `https://grandstand-api.<你的子域名>.workers.dev/api/health`，
   会看到类似 `{"ok":true,"espn":"200 ok","users":0,"subs":0}`。
   - `espn` 是 `200 ok`：比分推送和服务器结算都能用。
   - 不是 200：ESPN 拒绝了 Cloudflare 的请求。账号、排行榜、评分照常可用，推送和足球/NBA 的服务器结算会停着。

把这个地址发给我，我填进 app 里（`index.html` 的 `API_BASE`），这些功能就会出现在 app 上。

## 用量

免费版够用：每天 10 万次请求、每次请求 10 毫秒 CPU，D1 每天 500 万次读取。
每分钟的检查只请求有人关注的联赛，一天大约 1440 次触发。

密码用 PBKDF2-SHA256 加盐存储。为了放进免费版的 10 毫秒 CPU 限额，迭代次数是 1 万次；
换成付费版后，可以加一个变量 `PBKDF2_ITER` 调高，旧密码不受影响（每条记录存了自己的次数）。

## 开发和测试

- `test.html`：用本地服务器打开，会在浏览器里跑整个 Worker（数据库换成 sql.js，ESPN 和推送服务是假的），
  覆盖注册登录、预测、排行榜、评分、推送加密解密、每分钟的开赛/进球/完场推送、服务器结算。
- `dev-api.js`：在 app 页面里跑一个本地 Worker，不用部署就能试界面：
  ```js
  localStorage.setItem('apiBase', JSON.stringify('https://api.test')); location.reload();
  await import('/worker/dev-api.js');
  ```
  用完删掉 `apiBase`：`localStorage.removeItem('apiBase')`。
