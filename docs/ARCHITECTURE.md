# vscode-ptt 流程圖與使用方式

## 一、整體架構

```mermaid
flowchart LR
  subgraph VSCode["VS Code 擴充套件 (src/)"]
    EXT["extension.ts<br/>啟動、指令註冊、登入流程"]
    TREE["views/PttTreeView.tsx<br/>側邊欄「文章列表」(React TreeView)"]
    FS["provider.ts<br/>ptt:// 唯讀檔案系統"]
    HOVER["hoverProvider.ts<br/>圖片 / Imgur 懸浮預覽"]
    LIVE["liveTracker.ts<br/>即時追推文 (定時刷新)"]
    STORE["store.ts<br/>文章列表 / 我的最愛快取"]
    Q["PttQueue<br/>序列化所有 PTT 請求"]
    GS[("globalState<br/>帳密、boardlist、cachedFavorites")]
  end

  subgraph CLIENT["packages/ptt-client"]
    BOT["bot.ts<br/>login / getFavorite / getArticles / getArticle"]
    TERM["terminal/<br/>解析 BBS 畫面"]
    SOCK["socket.ts<br/>WebSocket"]
  end

  PTT[("wss://ws.ptt.cc/bbs")]

  EXT --> TREE & FS & HOVER & LIVE
  EXT <--> GS
  TREE <--> STORE
  TREE & FS & EXT --> Q --> BOT
  LIVE --> FS
  BOT --> TERM
  BOT <--> SOCK <--> PTT
```

## 二、啟動與登入流程

```mermaid
flowchart TD
  A([VS Code 啟動 / 觸發 ptt 指令]) --> B[activate]
  B --> C[從 globalState 載入快取的我的最愛]
  C --> D[建立 PTT client 並連線 term.ptt.cc<br/>逾時 5 秒]
  D --> E[建立 TreeView、ptt:// FileSystemProvider、<br/>HoverProvider、LiveTracker，註冊指令]
  E --> F["靜默登入 login(silent=true)"]
  F --> G{已連線?}
  G -- 否 --> X[維持未登入<br/>側邊欄顯示「登入」按鈕]
  G -- 是 --> H{globalState 有帳密?}
  H -- 否 --> X
  H -- 是 --> I["ptt.login(帳號, 密碼, kickLogin)<br/>逾時 15 秒"]
  I -- 成功 --> J[設定 ptt:loggedIn = true<br/>刷新 TreeView]
  I -- 失敗 --> X

  X --> M([使用者點「登入」/ PTT: 登入])
  M --> N[輸入帳號<br/>guest 免密碼]
  N --> O[輸入密碼]
  O --> P[ptt.login]
  P -- 成功 --> Q[儲存帳密至 globalState<br/>顯示「以 xxx 登入成功！」] --> J
  P -- 失敗 --> R[要求重新輸入一次帳密] --> P2[再次 ptt.login]
  P2 -- 成功 --> Q
  P2 -- 失敗 --> S[顯示「登入失敗 QQ」]
```

## 三、瀏覽看板與文章

```mermaid
flowchart TD
  A([側邊欄「文章列表」]) --> B{已登入?}
  B -- 否 --> L[「尚未登入 PTT」→ 點擊登入]
  B -- 是 --> C[我的最愛<br/>ptt.getFavorite，結果快取]
  B -- 是 --> D[其他看板<br/>globalState.boardlist]

  D --> D1["＋ 新增訂閱看板<br/>輸入看板名 → enterBoard 檢查存在"]
  D1 -- 存在 --> D2[加入 boardlist]
  D1 -- 不存在 --> D3[「此看板不存在」]

  C & D --> E[展開看板]
  E --> F[ptt.getArticles 取最新 20 篇<br/>存入 store]
  F --> G[文章節點<br/>📌置底 / 🔥50推以上或爆 / 💬有推文]
  F --> H[「載入更多文章」<br/>ptt.load-more-article 以 lastSn 往前翻]
  H --> F

  G -- 點擊 --> I["ptt.show-article<br/>開啟 ptt:/看板/編號.ptt"]
  I --> J{FileSystemProvider<br/>快取命中?}
  J -- 是 --> K[直接顯示]
  J -- 否 --> J1[必要時自動登入 → ptt.getArticle<br/>逐頁 PgDown 讀完全文] --> J2[寫入快取] --> K
  K --> K1[ptt 語法高亮<br/>滑鼠移到圖片連結 → 懸浮預覽]

  E -- 右鍵 --> R1[重新整理此看板文章]
  E -- 右鍵 --> R2["以推文數搜尋<br/>輸入 0~100 → setSearchCondition('push')"] --> F
  E -- 右鍵 --> R3[移除訂閱看板]
```

## 四、即時追推文 (Live Tracking)

```mermaid
flowchart TD
  A([文章分頁右上角 📡 / 右鍵 / 狀態列]) --> B{目前是 ptt:// 文章?}
  B -- 否 --> W[提示：請先開啟 PTT 文章]
  B -- 是 --> C{已登入?}
  C -- 否 --> W2[提示：請先登入]
  C -- 是 --> D[建立 session<br/>每 liveTrackingInterval 秒 (預設 3) 執行]
  D --> E[refreshArticle：重新 getArticle]
  E --> F{內容有變?}
  F -- 是 --> G[觸發 onDidChangeFile → 編輯器更新<br/>liveTrackingAutoScroll 時捲到底]
  F -- 否 --> D
  G --> D
  D -.-> H([停止：再按一次 ⏹ / 關閉分頁 / 斷線 / 登出])
```

## 五、使用方式

### 安裝

1. 在 VS Code 擴充功能市集搜尋 **「VSCode 批踢踢」**（`Yukai.vscode-ptt`）安裝，或：
   ```bash
   code --install-extension Yukai.vscode-ptt
   ```
2. 左側活動列出現 PTT 圖示，點開即為「文章列表」。

### 基本操作

| 想做的事 | 操作方式 |
| --- | --- |
| 登入 | 側邊欄「登入」按鈕，或指令面板 `PTT: 登入`。帳號輸入 `guest` 可免密碼。帳密會記住，下次啟動自動登入 |
| 訂閱看板 | 側邊欄標題列 `＋`，輸入看板名稱（如 `C_Chat`、`Gossiping`） |
| 從我的最愛訂閱 | 「我的最愛」會自動列出你 PTT 帳號的最愛看板；也可用指令 `ptt.favorite-board` 挑選加入「其他看板」 |
| 看文章 | 展開看板 → 點文章標題，於編輯器以唯讀方式開啟 |
| 載入更舊文章 | 看板底部「載入更多文章」 |
| 以推文數篩選 | 看板右鍵 → 「以推文數搜尋」，輸入 0~100 |
| 重新整理 | 看板右側 🔄 重新整理該看板；標題列 🔄 重新整理看板列表與我的最愛（同時清除推文數篩選） |
| 移除看板 | 看板右鍵 → 「移除訂閱看板」 |
| 即時追推文 | 開啟文章後按編輯器右上角 📡（或 `PTT: 切換即時追推文`），再按 ⏹ 停止 |
| 圖片預覽 | 滑鼠停在文章中的 imgur / 圖片網址上 |
| 登出 | 標題列登出按鈕（會一併清除帳密與訂閱看板） |

### 設定 (settings.json)

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `kickLogin` | `false` | 登入時踢掉其他重複登入 |
| `previewImages` | `true` | 懸浮提示中預覽圖片 |
| `previewImageWidth` | `320` | 預覽寬度（px，0 為不限制） |
| `liveTrackingInterval` | `3` | 即時追推文刷新秒數（1~60） |
| `liveTrackingAutoScroll` | `true` | 追推文時自動捲到底 |

### 開發

需要 Node.js 與 pnpm（見 `mise.toml`）。

```bash
pnpm install
```

```bash
pnpm build        # 打包 ptt-client 與擴充套件到 out/extension.js
```

```bash
pnpm test         # 編譯 + 單元測試 + ptt-client 測試
```

```bash
pnpm package      # 產生 .vsix
```

在 VS Code 開啟專案後按 F5 選 **Run Extension**，會開新視窗載入開發中的擴充套件。整合測試帳密可參考 `.env.example`。
