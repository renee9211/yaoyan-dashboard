# P2｜公開儲存庫整理與 Firebase App Check / API Key 檢查

更新：2026-11-16

## A. GitHub 公開檔案整理（已處理）

- 從主分支移除未被正式入口引用的 `preview-deal-subtotal/` 整套舊版前端。正式網址的根目錄 `index.html`、`app.js`、`firebase.js` 等不修改。
- 誤放的 `package.json` 實際是 PNG Logo 二進位內容；`package-lock.json` 實際是忽略清單文字，均移除。
- 新增真正的 `.gitignore`，避免未來誤提交環境變數、服務帳號 JSON、憑證以及本機建置內容。
- **重要：從最新分支移除不等於清除 Git 歷史。** 歷史提交、分支、已下載的副本仍可能包含已刪除檔案。如果將來發現真正密鑰洩漏，應先撤銷／輪替，再評估歷史清理。
- GitHub Pages 若原本有人直接使用舊的 `/preview-deal-subtotal/` 路徑，合併後該路徑會失效；正式網站根路徑不受此目錄移除影響。
- 如未來需要新版測試環境，請另外使用受控的測試部署，不要將真實客戶資料放在公開靜態檔。

## B. 目前從程式碼可確認

- Web Firebase config 包含公開型 `apiKey`、`authDomain`、`projectId`。Firebase Web API Key 並不是用來授予 Firestore 資料讀取權限的秘密，資料存取仍必須由 Security Rules 保護。
- 現行 `firebase.js` 未整合 App Check SDK，也沒有 reCAPTCHA Enterprise Site Key。
- 無法從 GitHub 公開程式查出 Google Cloud Console 中 API Key 是否已有 **API 限制**、**網站來源限制**，或 Firebase Console 中 App Check 是否已有註冊、驗證率及 enforcement 狀態；這些設定不能憑空視為已完成。

## C. 啟用 App Check 的安全部署程序（尚待 Console 設定）

1. 在 Firebase Console 選擇 `yaoyan-fb9cb`，開啟 **Build / Security → App Check**，確認 Web App 是否已註冊。
2. 依 Firebase 官方「App Check with reCAPTCHA Enterprise」文件註冊 Web App，建立符合 Firebase 需求的 score-based reCAPTCHA Enterprise Site Key。允許正式網域 `renee9211.github.io`；若有其他使用中的網域或測試環境，也需納入規劃。
3. 取得 **Site Key（公開型網站金鑰）** 後，才把 Firebase App Check Web SDK 以目前專案使用的 Firebase SDK 版本整合於 `firebase.js`，在資料請求前初始化並啟用自動更新 Token。
4. 將前端上線，但 **先不要按 Enforce**。從 Firebase Console 的 **App Check → APIs** 觀察 Cloud Firestore 等服務的 verified / outdated / invalid 請求比例。以 Admin、Editor 與 Viewer 測試正常登入及資料讀寫；測試需要用到的各種網域。
5. 確認真實使用者請求已通過驗證後，才逐項開啟 Cloud Firestore enforcement。啟用後未附有效 App Check token 的請求將被拒絕；若有異常，應立即回到 Console 檢查並考慮關閉 enforcement。
6. App Check **不能取代 Security Rules**；不要讓尚未核准的使用者因為 App Check 通過就能讀寫資料。

## D. API Key 限制檢查（尚待 Google Cloud Console）

1. 前往 Google Cloud Console → **APIs & Services → Credentials**，選擇與 Firebase Web App 設定中 `apiKey` 對應的 API Key；請勿公開額外的私密憑證。
2. 查看 **API restrictions**。限制為專案真正需要的 Firebase 相關 APIs；不要在沒有實測下貿然刪除 Firebase Authentication 或 App Check 所需的服務。
3. 查看 **Application restrictions**。如使用 HTTP referrer 限制，務必讓 `renee9211.github.io` 的網站來源與實際使用的路徑、網域符合設定；留意這類限制並非真正的使用者授權機制，且可能影響登入。
4. 如需變更限制，先測試 Admin / Editor 登入、Firestore 讀寫、報價管理、Google Calendar 同步與相關 Cloud Functions 功能，再逐步套用正式金鑰。
5. **切勿**因 API Key 在前端可見就直接刪除或任意輪替；應先確認受限 API 及依賴服務。

## E. 驗收紀錄

| 項目 | 狀態 |
|---|---|
| GitHub 預覽版與誤放檔案清理 | 已完成，待本分支合併 |
| GitHub `.gitignore` | 已建立，待合併 |
| 目前 `firebase.js` 是否具 App Check 初始化 | 已檢查：沒有 |
| App Check 註冊、Site Key、前端接入 | 未完成，需 Console 設定 |
| App Check Verified 流量與 Enforce | 未完成，必須先監控 |
| API Key 的 Google Cloud 限制實況 | 未能取得，需 Console 查核 |

官方參考：
- https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider
- https://firebase.google.com/docs/app-check/monitor-metrics
- https://firebase.google.com/docs/projects/api-keys
