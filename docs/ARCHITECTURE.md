# vscode-ptt 流程圖與使用方式

## 一、整體架構

```mermaid
flowchart LR
  subgraph VSCode["VS Code 擴充套件 (src/)"]
    EXT["extension.ts<br/>啟動、指令註冊、登入流程"]
    TREE["views/PttTreeView.tsx<br/>側邊欄「文章列表」(React TreeView)"]
    FS["provider.ts<br/>kalpy-ptt:// 唯讀檔案系統"]
    HOVER["hoverProvider.ts + linkPreview.ts<br/>圖片 / 外部連結懸浮預覽"]
    LIVE["liveTracker.ts<br/>即時追推文 (定時刷新)"]
    STORE["store.ts<br/>文章列表 / 我的最愛快取"]
    Q["PttQueue<br/>序列化所有 PTT 請求"]
    GS[("globalState<br/>帳密、登入模式、本地喜愛看板（同步）、cachedFavorites")]
  end

  subgraph CLIENT["packages/ptt-client"]
    BOT["bot.ts<br/>login / getFavorite / getArticles / getArticle"]
  end

  subgraph WEB["訪客模式"]
    WC["webClient.ts<br/>爬取 www.ptt.cc 網頁版 (唯讀)"]
    TERM["terminal/<br/>解析 BBS 畫面"]
    SOCK["socket.ts<br/>WebSocket"]
  end

  PTT[("wss://ws.ptt.cc/bbs")]
  WWW[("https://www.ptt.cc/bbs")]

  EXT --> TREE & FS & HOVER & LIVE
  EXT <--> GS
  TREE <--> STORE
  TREE & FS & EXT --> Q --> BOT
  LIVE --> FS
  BOT --> TERM
  BOT <--> SOCK <--> PTT
  Q -. 帳號為 guest .-> WC <--> WWW
```

## 二、啟動與登入流程

```mermaid
flowchart TD
  A([VS Code 啟動 / 觸發 ptt 指令]) --> B[activate]
  B --> C[從 globalState 載入快取的我的最愛]
  C --> D[建立 PTT client 並連線 term.ptt.cc<br/>逾時 5 秒]
  D --> E[建立 TreeView、kalpy-ptt:// FileSystemProvider、<br/>HoverProvider、LiveTracker，註冊指令]
  E --> F["靜默登入 login(silent=true)"]
  F --> LM{上次是訪客模式?<br/>loginMode == guest}
  LM -- 是 --> GW
  LM -- 否 --> H{globalState 有帳密?}
  H -- 否 --> X[維持未登入<br/>側邊欄顯示「以帳號登入」與<br/>「以訪客身分瀏覽」兩個按鈕]
  H -- 一般帳號 --> G{已連線 BBS?}
  G -- 否 --> X
  G -- 是 --> I["ptt.login(帳號, 密碼, kickLogin)<br/>逾時 15 秒"]
  GW["改用 WebPttClient<br/>連 www.ptt.cc (帶 over18 cookie)"] -- 成功 --> J
  GW -- 失敗 --> X
  I -- 成功 --> J[設定 kalpyPtt:loggedIn = true<br/>刷新 TreeView]
  I -- 失敗 --> X

  X --> GB([點「以訪客身分瀏覽」<br/>PTT: 以訪客身分瀏覽]) --> GW
  X --> M([點「以帳號登入」<br/>PTT: 以帳號登入])
  M --> N[輸入帳號]
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
  B -- 否 --> L[「以帳號登入」/「以訪客身分瀏覽」]
  B -- 是 --> D[❤ 本地喜愛看板<br/>存在本機、帳號與訪客共用、<br/>登出不清除、透過設定同步帶到其他電腦]
  B -- 是 --> C[我的最愛（訪客為「熱門看板」）<br/>ptt.getFavorite，結果快取]

  D --> D1["＋ 新增本地喜愛看板<br/>輸入看板名 → enterBoard 檢查存在"]
  D1 -- 存在 --> D2[加入本地喜愛看板]
  D1 -- 不存在 --> D3[「此看板不存在」]
  C -- 看板旁 ❤ --> D2
  C -- 標題旁「全部加入」--> D2
  D -- 匯出 / 匯入 --> D4[(JSON 備份檔)]

  C & D --> E[展開看板]
  E --> F[ptt.getArticles 取最新 20 篇<br/>存入 store]
  F --> G[文章節點<br/>📌置底 / 🔥50推以上或爆 / 💬有推文]
  F --> H[「載入更多文章」<br/>ptt.load-more-article 以 lastSn 往前翻]
  H --> F

  G -- 點擊 --> I["kalpy.ptt.show-article<br/>開啟 kalpy-ptt:/看板/編號.ptt"]
  I --> J{FileSystemProvider<br/>快取命中?}
  J -- 是 --> K[直接顯示]
  J -- 否 --> J1[必要時自動登入 → ptt.getArticle<br/>逐頁 PgDown 讀完全文] --> J2[寫入快取] --> K
  K --> K1[ptt 語法高亮<br/>滑鼠移到圖片連結 → 懸浮預覽]

  E -- 右鍵 --> R1[重新整理此看板文章]
  E -- 右鍵 --> R2["以推文數搜尋<br/>輸入 0~100 → setSearchCondition('push')"] --> F
  E -- 右鍵（本地喜愛看板）--> R3[從本地喜愛看板移除]
```

## 四、即時追推文 (Live Tracking)

```mermaid
flowchart TD
  A([文章分頁右上角 📡 / 右鍵 / 狀態列]) --> B{目前是 kalpy-ptt:// 文章?}
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

### 安裝（從自己的 Fork 打包 .vsix）

需要 Node.js 20+ 與 pnpm。

```bash
git clone https://github.com/<你的帳號>/vscode-ptt.git
```

```bash
cd vscode-ptt
```

```bash
pnpm install
```

```bash
pnpm run package:local
```

會在專案根目錄產生 `vscode-ptt.vsix`。接著在 **VS Code 裡**安裝：

1. 打開擴充功能面板（`Ctrl+Shift+X`）
2. 右上角 `⋯` → **從 VSIX 安裝…**（Install from VSIX…），選 `vscode-ptt.vsix`
3. 按通知上的「重新載入」，左側活動列會出現「VSCode PTT (kalpy)」

#### 之後更新（一個指令搞定）

裝過一次之後，按 `Ctrl+Shift+P` 執行 **PTT: 從原始碼更新擴充功能**（或側邊欄標題列 `⋯` → 「從原始碼更新擴充功能」），它會：

1. 在原始碼資料夾執行 `pnpm run package:local`（終端機會顯示打包過程）
2. 用 VS Code 內建的安裝功能裝上新的 `vscode-ptt.vsix`（和「從 VSIX 安裝…」同一套機制）
3. 問你要不要重新載入視窗

版本號沒變也會強制覆蓋安裝：先用 VS Code 內建安裝（會取代同版本的資料夾），失敗時改用 VS Code 自帶的 `code --install-extension ... --force`；安裝後也會清掉 `.obsolete` 裡這一版的「已移除」標記，避免下次啟動時被刪掉。完成通知會寫明是「同版本覆蓋」還是「從舊版更新」。

第一次會請你選原始碼資料夾（含 `package.json` 的那一層），之後會記住；如果目前開著的工作區就是原始碼，會自動使用。要換資料夾時執行 **PTT: 從原始碼更新擴充功能（重新選擇資料夾）**。記得先 `git pull` 拿到最新程式碼。

> **不建議在 VS Code 開著時用 `code --install-extension`（或 `pnpm run install:local`）安裝。** 開著的視窗可能把自己記憶中的擴充功能清單（`~/.vscode/extensions/extensions.json`）寫回去，蓋掉剛裝的那一筆，結果資料夾在、`code --list-extensions` 也列得出來，但 VS Code 裡完全看不到。要用指令列安裝，請先關閉所有 VS Code 視窗。

這個 Fork 的擴充功能 ID 是 `kalpy.vscode-ptt`（原版為 `Yukai.vscode-ptt`），市集的自動更新不會覆蓋它。Fork 自己註冊的東西都加了 `kalpy` 前綴，可以和原版同時安裝：

| 項目 | 原版 | 這個 Fork |
| --- | --- | --- |
| 指令 | `ptt.login` … | `kalpy.ptt.login` … |
| 側邊欄 | `ptt-explorer` / `pttTree` | `kalpy-ptt-explorer` / `kalpyPttTree`，標題「VSCode PTT (kalpy)」 |
| 文章網址 | `ptt:/看板/編號.ptt` | `kalpy-ptt:/看板/編號.ptt` |
| 狀態鍵 | `ptt:loggedIn` … | `kalpyPtt:loggedIn` … |

兩者共用的只有 `ptt` 語言（語法高亮）和設定值（`kickLogin`、`previewImages` 等），改設定會同時影響兩邊。

#### 裝了卻看不到圖示

1. 擴充功能面板搜尋 `@installed kalpy`。找不到的話，多半是上面說的清單被覆蓋：關閉所有 VS Code 視窗，執行 `code --uninstall-extension kalpy.vscode-ptt`，刪掉 `~/.vscode/extensions/kalpy.vscode-ptt-*` 資料夾，以及 `~/.vscode/extensions/.obsolete`（若裡面有 kalpy），再用「從 VSIX 安裝…」重裝
2. 在左側活動列按右鍵，確認「VSCode PTT (kalpy)」沒有被隱藏
3. 用 VS Code 打開專案按 `F5` →「Run Extension」，在不安裝的情況下直接跑原始碼，可以確認是程式還是安裝的問題

注意事項：

- `package.json` 指定的是 `pnpm@12`。如果你的 pnpm 版本切換失敗，可以用 `mise install` 裝指定版本，或在 `~/.npmrc` 加上 `manage-package-manager-versions=false`，改用本機的 pnpm 10。

### 部署

#### A. 安裝到自己的 VS Code（最常用）

同上一節：`pnpm run package:local` 打包，再在 VS Code 裡「從 VSIX 安裝…」。

#### B. 發佈 GitHub Release（給其他電腦或朋友安裝）

先把 `package.json` 的 `version` 改成新版本並 commit，再打同版本號的 tag 推上去：

```bash
git tag v0.4.2
```

```bash
git push origin v0.4.2
```

GitHub Actions 的 `Publish Extension` 會跑 lint、測試、打包，並把 `vscode-ptt.vsix` 掛到同名 Release。其他電腦下載後執行：

```bash
code --install-extension vscode-ptt.vsix --force
```

想先確認能不能打包、但不發佈，可以在 GitHub 的 Actions 頁面手動執行 `Publish Extension`，勾選 `dry_run`。

#### C. 發佈到市集（選用）

需要先在 Visual Studio Marketplace 建立名為 `kalpy` 的 publisher，並在 repo 的 Settings → Secrets 設定 `VSCE_PAT`（Open VSX 則是 `OVSX_PAT`）。沒有設定的話，workflow 會跳過市集發佈，只建立 GitHub Release。

### 基本操作

| 想做的事 | 操作方式 |
| --- | --- |
| 以帳號登入 | 側邊欄「以帳號登入」（標題列 🔑），或指令面板 `PTT: 以帳號登入`。帳密會記住，下次啟動自動登入。在訪客模式中按這個鈕會切換回帳號 |
| 以訪客身分瀏覽 | 側邊欄「以訪客身分瀏覽」（標題列 👁），或指令面板 `PTT: 以訪客身分瀏覽（唯讀）`。不需要帳號，改讀網頁版 www.ptt.cc：可以瀏覽看板與文章、以推文數搜尋、即時追推文；側邊欄的「我的最愛」會換成「熱門看板」。只能看、不能推文或發文。切到訪客模式不會刪掉記住的帳密；下次啟動會沿用上次的模式 |
| 本地喜愛看板 | 存在這台電腦的看板清單，帳號與訪客模式共用，登出、換帳號、PTT 帳號消失都不會不見。開啟 VS Code「設定同步」時會自動帶到其他電腦 |
| 新增本地喜愛看板 | 標題列 `＋` 或「本地喜愛看板」旁的 `＋`，輸入看板名稱（如 `C_Chat`） |
| 從我的最愛／熱門看板加入 | 看板旁的 ❤ 加入單一看板；「我的最愛」/「熱門看板」標題旁的 ☁ 一次全部加入（等於把 PTT 帳號的我的最愛備份到本機） |
| 匯出／匯入 | 標題列 `⋯` →「匯出本地喜愛看板」存成 JSON；換電腦後「匯入本地喜愛看板」選那個檔案（也接受一行一個看板名稱的文字檔），重複的看板會自動略過 |
| 看文章 | 展開看板 → 點文章標題，於編輯器以唯讀方式開啟 |
| 載入更舊文章 | 看板底部「載入更多文章」 |
| 以推文數篩選 | 看板右鍵 → 「以推文數搜尋」，輸入 0~100 |
| 重新整理 | 看板右側 🔄 重新整理該看板；標題列 🔄 重新整理看板列表與我的最愛（同時清除推文數篩選） |
| 移除看板 | 本地喜愛看板裡的看板右鍵 → 「從本地喜愛看板移除」 |
| 即時追推文 | 開啟文章後按編輯器右上角 📡（或 `PTT: 切換即時追推文`），再按 ⏹ 停止 |
| 圖片與連結預覽 | 滑鼠停在文章中的網址上：圖片網址直接顯示圖片；其他連結顯示網頁的縮圖、標題與摘要（YouTube 顯示影片縮圖） |
| 登出 | 標題列登出按鈕（清除記住的帳密；本地喜愛看板保留） |

### 設定 (settings.json)

| 設定 | 預設 | 說明 |
| --- | --- | --- |
| `kickLogin` | `false` | 登入時踢掉其他重複登入 |
| `previewImages` | `true` | 懸浮提示中預覽圖片 |
| `previewLinks` | `true` | 懸浮預覽外部連結的縮圖、標題與摘要 |
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
