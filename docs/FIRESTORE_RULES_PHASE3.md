# Firestore Security Rules — 曜炎 Dashboard 權限修正版（2026-11-16）

> 注意：此檔為版本化的規則參考，**不是 Firebase Console 的即時讀取結果**。內容依 2026-11-16 對話中已交付並由管理員回報發布、完成角色測試的修正版整理。若後續 Console 有修改，必須重新同步本文件。

## 主要安全限制

- 只有已核准的使用者能讀取專案、報價、財務、客戶、設備資料。
- 所有功能權限函式先檢查 `isApproved()`，避免未核准使用者靠自訂 permissions 寫入資料。
- 新用戶只能建立未核准 Viewer，不可額外申報自訂權限。
- 非管理員只能修改自己有限的個人欄位，新增／刪除欄位也會被 `affectedKeys()` 阻擋。
- 保留既有 `admin`、`editor`、`viewer` 與 Legacy Editor 相容行為；本規則尚未支援跨公司隔離。
- `users` 文件目前禁止刪除；前端「移除申請」是將使用者狀態封存／拒絕，非刪除 Authentication 帳號。

## 規則全文

```javascript
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() {
      return request.auth != null;
    }

    function userData() {
      return get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
    }

    function hasUserDoc() {
      return isSignedIn() && exists(/databases/$(database)/documents/users/$(request.auth.uid));
    }

    function isApproved() {
      return hasUserDoc() && (
        (("approved" in userData()) && userData().approved == true) ||
        (!("approved" in userData()) && userData().role in ["admin", "editor"])
      );
    }

    function userRole() {
      return isApproved() ? userData().role : null;
    }

    function isAdmin() {
      return userRole() == "admin";
    }

    function isLegacyEditor() {
      return userRole() == "editor" && !("permissions" in userData());
    }

    function canCreateProjects() {
      return isApproved() && (isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.createProjects == true));
    }

    function canEditProjects() {
      return isApproved() && (isAdmin() ||
        (("permissions" in userData()) && userData().permissions.editProjects == true));
    }

    function canManageQuotations() {
      return isApproved() && (isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageQuotations == true));
    }

    function canManagePayments() {
      return isApproved() && (isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.managePayments == true));
    }

    function canManageExpenses() {
      return isApproved() && (isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageExpenses == true));
    }

    function canManageCompanyExpenses() {
      return isApproved() && (isAdmin() ||
        (userRole() == "editor" && (!("permissions" in userData()) || !("manageCompanyExpenses" in userData().permissions))) ||
        (("permissions" in userData()) && userData().permissions.manageCompanyExpenses == true));
    }

    function canCreateEquipment() {
      return isApproved() && (isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.createEquipment == true));
    }

    function canEditEquipment() {
      return isApproved() && (isAdmin() ||
        (("permissions" in userData()) && userData().permissions.editEquipment == true));
    }

    function canManageCustomers() {
      return isApproved() && (isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageCustomers == true));
    }

    function canManageCatalog() {
      return isApproved() && (isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageCatalog == true));
    }

    function canViewAudit() {
      return isApproved() && (isAdmin() ||
        (("permissions" in userData()) && userData().permissions.viewAudit == true));
    }

    function validProjectData() {
      return request.resource.data.name is string &&
        request.resource.data.name.size() > 0 &&
        request.resource.data.revenue is int && request.resource.data.revenue >= 0 &&
        request.resource.data.cost is int && request.resource.data.cost >= 0 &&
        request.resource.data.status in ["planning", "confirmed", "executing", "closed", "lost"] &&
        request.resource.data.startDate is string &&
        request.resource.data.endDate is string &&
        request.resource.data.startDate <= request.resource.data.endDate;
    }

    function validEquipmentData() {
      return request.resource.data.name is string && request.resource.data.name.size() > 0 &&
        request.resource.data.qty is int && request.resource.data.qty >= 0 &&
        (!("note" in request.resource.data) || request.resource.data.note is string) &&
        (!("unitPurchasePrice" in request.resource.data) || (request.resource.data.unitPurchasePrice is int && request.resource.data.unitPurchasePrice >= 0)) &&
        (!("residualValue" in request.resource.data) || (request.resource.data.residualValue is int && request.resource.data.residualValue >= 0)) &&
        (!("depreciationYears" in request.resource.data) || (request.resource.data.depreciationYears is int && request.resource.data.depreciationYears >= 1)) &&
        (!("annualUsageDays" in request.resource.data) || (request.resource.data.annualUsageDays is int && request.resource.data.annualUsageDays >= 0));
    }

    function validPaymentData() {
      return request.resource.data.projectId is string && request.resource.data.projectId.size() > 0 &&
        request.resource.data.projectName is string && request.resource.data.customerName is string &&
        request.resource.data.paymentType in ["deposit", "balance", "full", "other"] &&
        request.resource.data.amount is int && request.resource.data.amount > 0 &&
        request.resource.data.receivedAmount is int && request.resource.data.receivedAmount >= 0 &&
        request.resource.data.receivedAmount <= request.resource.data.amount &&
        request.resource.data.voided is bool;
    }

    function validReceiptData() {
      return request.resource.data.paymentId is string && request.resource.data.paymentId.size() > 0 &&
        request.resource.data.projectId is string &&
        request.resource.data.projectName is string && request.resource.data.customerName is string &&
        request.resource.data.billingLabel is string &&
        request.resource.data.amount is int && request.resource.data.amount > 0 &&
        request.resource.data.receivedDate is string && request.resource.data.receivedDate.size() > 0 &&
        request.resource.data.method in ["bank_transfer", "cash", "check", "card", "other", "legacy"] &&
        request.resource.data.reference is string && request.resource.data.note is string &&
        request.resource.data.voided is bool;
    }

    function validExpenseData() {
      return request.resource.data.projectId is string && request.resource.data.projectId.size() > 0 &&
        request.resource.data.projectName is string && request.resource.data.customerName is string &&
        request.resource.data.expenseDate is string &&
        request.resource.data.category in ["outsourcing_equipment", "temporary_staff", "transport", "consumables", "venue", "other"] &&
        request.resource.data.amount is int && request.resource.data.amount > 0 &&
        request.resource.data.taxMode in ["taxed", "untaxed"] &&
        request.resource.data.costUntaxed is int && request.resource.data.costUntaxed >= 0 &&
        (!('payableTracked' in request.resource.data) || request.resource.data.payableTracked is bool) &&
        (!('vendorBillDate' in request.resource.data) || request.resource.data.vendorBillDate is string) &&
        (!('expectedPaymentDate' in request.resource.data) || request.resource.data.expectedPaymentDate is string) &&
        (!('paidDate' in request.resource.data) || request.resource.data.paidDate is string) &&
        (!('paymentMethod' in request.resource.data) || request.resource.data.paymentMethod in ["bank_transfer", "cash", "check", "card", "other"]) &&
        request.resource.data.voided is bool;
    }

    function validCompanyExpenseData() {
      return request.resource.data.expenseDate is string &&
        request.resource.data.category in ["rent", "utilities", "payroll", "insurance", "software", "equipment_purchase", "equipment_maintenance", "office", "marketing", "professional", "other"] &&
        request.resource.data.expenseType in ["operating", "capital"] &&
        request.resource.data.name is string && request.resource.data.name.size() > 0 &&
        request.resource.data.vendor is string &&
        request.resource.data.receiptNumber is string &&
        request.resource.data.amount is int && request.resource.data.amount > 0 &&
        request.resource.data.taxMode in ["taxed", "untaxed"] &&
        request.resource.data.costUntaxed is int && request.resource.data.costUntaxed >= 0 &&
        request.resource.data.equipmentId is string &&
        request.resource.data.equipmentName is string &&
        (!('payableTracked' in request.resource.data) || request.resource.data.payableTracked is bool) &&
        (!('vendorBillDate' in request.resource.data) || request.resource.data.vendorBillDate is string) &&
        (!('expectedPaymentDate' in request.resource.data) || request.resource.data.expectedPaymentDate is string) &&
        (!('paidDate' in request.resource.data) || request.resource.data.paidDate is string) &&
        (!('paymentMethod' in request.resource.data) || request.resource.data.paymentMethod in ["bank_transfer", "cash", "check", "card", "other"]) &&
        request.resource.data.note is string &&
        request.resource.data.voided is bool &&
        ((request.resource.data.category == "equipment_purchase" && request.resource.data.expenseType == "capital") ||
         (request.resource.data.category != "equipment_purchase" && request.resource.data.expenseType == "operating"));
    }

    function validAuditData() {
      return request.resource.data.actorUid == request.auth.uid &&
        request.resource.data.actorEmail == request.auth.token.email &&
        request.resource.data.action in ["create", "update", "delete", "void", "sync", "receive", "permission"] &&
        request.resource.data.module in ["projects", "quotations", "payments", "expenses", "companyExpenses", "customers", "catalog", "equipment", "permissions"] &&
        request.resource.data.targetType is string &&
        request.resource.data.targetId is string &&
        request.resource.data.targetName is string &&
        request.resource.data.summary is string;
    }

    match /users/{userId} {
      allow get: if isSignedIn() && (request.auth.uid == userId || isAdmin());
      allow list: if isSignedIn() && isAdmin();

      // New users can only register as unapproved viewers. No custom privileges.
      allow create: if isSignedIn() && request.auth.uid == userId &&
        request.resource.data.keys().hasOnly([
          "email", "displayName", "role", "approved", "permissions", "createdAt", "updatedAt"
        ]) &&
        request.resource.data.role == "viewer" &&
        request.resource.data.approved == false &&
        (!('permissions' in request.resource.data) ||
          request.resource.data.permissions == {
            "createProjects": false,
            "editProjects": false,
            "manageQuotations": false,
            "managePayments": false,
            "manageExpenses": false,
            "manageCompanyExpenses": false,
            "createEquipment": false,
            "editEquipment": false,
            "manageCustomers": false,
            "manageCatalog": false,
            "viewAudit": false
          });

      allow update: if isSignedIn() && (
        (request.auth.uid == userId &&
          request.resource.data.diff(resource.data).affectedKeys().hasOnly(["updatedAt", "displayName", "email"])) ||
        (isAdmin() &&
          request.resource.data.role in ["admin", "editor", "viewer"] &&
          request.resource.data.approved is bool)
      );

      allow delete: if false;
    }

    match /projects/{projectId} {
      allow get, list: if isApproved();
      allow create: if canCreateProjects() && validProjectData();
      allow update: if canEditProjects() && validProjectData();
      allow delete: if isAdmin();
    }

    match /equipment/{equipmentId} {
      allow get, list: if isApproved();
      allow create: if canCreateEquipment() && validEquipmentData();
      allow update: if canEditEquipment() && validEquipmentData();
      allow delete: if isAdmin();
    }

    match /customers/{customerId} {
      allow get, list: if isApproved();
      allow create, update: if canManageCustomers();
      allow delete: if isAdmin();
    }

    match /quotationItems/{itemId} {
      allow get, list: if isApproved();
      allow create, update: if canManageCatalog();
      allow delete: if isAdmin();
    }

    match /quotations/{quotationId} {
      allow get, list: if isApproved();
      allow create, update: if canManageQuotations();
      allow delete: if isAdmin();
    }

    match /payments/{paymentId} {
      allow get, list: if isApproved();
      allow create, update: if canManagePayments() && validPaymentData();
      allow delete: if isAdmin();
    }

    match /receipts/{receiptId} {
      allow get, list: if isApproved();
      allow create, update: if canManagePayments() && validReceiptData();
      allow delete: if isAdmin();
    }

    match /expenses/{expenseId} {
      allow get, list: if isApproved();
      allow create, update: if canManageExpenses() && validExpenseData();
      allow delete: if isAdmin();
    }

    match /companyExpenses/{expenseId} {
      allow get, list: if isApproved();
      allow create, update: if canManageCompanyExpenses() && validCompanyExpenseData();
      allow delete: if isAdmin();
    }

    match /auditLogs/{logId} {
      allow get, list: if isApproved() && canViewAudit();
      allow create: if isApproved() && validAuditData();
      allow update, delete: if false;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## 驗證狀態

管理員回報：Admin 登入／專案／報價財務／權限管理、Editor 授權與未授權操作、未核准帳號讀取拒絕，均已通過人工操作測試。**尚不等於 Firebase Emulator 自動化測試或實際部署規則的 API 逐字驗證。**

修改本檔不會自動部署 Firebase Rules；任何修改均需通過 Emulator 並另行部署。
