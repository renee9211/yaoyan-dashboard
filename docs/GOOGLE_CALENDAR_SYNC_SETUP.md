# 曜炎 Dashboard｜Google Calendar 串接設定

本版會將 `yaoyanfx@gmail.com` 的 Google Calendar 單向同步至 Firestore `projects`，並自動出現在 Dashboard 的「專案管理」與「專案檔期」。

## 同步規則

| Google Calendar 動作 | Dashboard 結果 |
|---|---|
| 新增活動 | 建立一筆「規劃中」專案，帶入活動名稱、開始／結束日期與地點 |
| 修改活動名稱、日期或地點 | 更新同一筆專案的對應欄位，不覆蓋客戶、報價、設備、備註、支出及款項 |
| 刪除活動 | 保留專案與後續資料，標示「行事曆已刪除」 |
| 恢復已刪除活動 | 更新原專案並解除刪除標示 |

- 每 5 分鐘自動同步一次，因此活動通常會在 5 分鐘內出現在 Dashboard。
- 使用 Google Calendar event ID 建立固定的 Firestore 文件 ID，不會重複新增同一活動。
- 第一次啟用只匯入「今天往前 30 天」至未來的活動，不匯入多年歷史活動。
- 全天活動會將 Google 的排他結束日校正為 Dashboard 的實際最後一天。
- Dashboard 內手動修改「活動名稱、日期、地點」後，若 Google Calendar 活動再次變更，這三類欄位會以 Calendar 為準；其他欄位不會被同步覆蓋。

## 上線前準備

### 1. 確認 Firebase 計費方案

Firebase 專案 `yaoyan-fb9cb` 必須使用 Blaze 方案，Cloud Functions 與排程功能才能部署。

### 2. 啟用 Google Calendar API

1. 開啟 Google Cloud Console。
2. 選擇專案 `yaoyan-fb9cb`。
3. 進入「API 和服務 → 程式庫」。
4. 搜尋並啟用 **Google Calendar API**。

### 3. 將 Calendar 分享給同步程式

以 `yaoyanfx@gmail.com` 登入 Google Calendar：

1. 左側「我的日曆」找到要同步的主行事曆。
2. 點選「設定和共用」。
3. 在「與特定使用者或群組共用」新增：

   `288682348042-compute@developer.gserviceaccount.com`

4. 權限選擇「查看所有活動詳細資訊」。同步程式只有讀取 Calendar 的權限，不會新增、修改或刪除 Google Calendar 活動。

## 部署

在包含本檔案的 `yaoyan-dashboard` 資料夾執行：

```bash
npm install -g firebase-tools
firebase login
npm --prefix functions install
firebase use yaoyan-fb9cb
firebase deploy --only functions:syncYaoyanCalendar
```

部署完成後，Cloud Scheduler 會每 5 分鐘執行一次。若要立即測試，可到 Google Cloud Console 的「Cloud Scheduler」，找到 `syncYaoyanCalendar` 對應的排程後按「強制執行」。

## 驗證

1. 在 `yaoyanfx@gmail.com` Calendar 建立一筆測試活動，填寫名稱、日期及地點。
2. 等待最多 5 分鐘，或在 Cloud Scheduler 強制執行。
3. 登入 Dashboard，確認專案管理出現新專案。
4. 修改活動日期，確認同一專案更新而非重複新增。
5. 刪除活動，確認專案仍保留且顯示「行事曆已刪除」。

Firestore Rules 不必為同步程式修改；Firebase Admin SDK 只在後端執行，不會把 Calendar 權限或憑證放進 GitHub Pages 前端。

## 常見問題

- 顯示 403／Forbidden：確認 Google Calendar API 已啟用，且行事曆已分享給上述服務帳號並選擇「查看所有活動詳細資訊」。
- 活動只顯示「Busy」：服務帳號目前只有空閒／忙碌權限，請改成「查看所有活動詳細資訊」。
- Dashboard 沒有出現活動：確認 Functions 已部署成功，再查看 `syncYaoyanCalendar` 的 Functions log。
- 重複專案：不要手動複製 Calendar 自動建立的專案；程式本身會以 event ID 去重。
