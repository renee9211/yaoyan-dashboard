# 第三階段 v7（標準財務流程）完整 Firestore Rules

第三階段新增：

- `expenses`：逐筆外部支出
- `companyExpenses`：不連結單一專案的公司營運支出與設備採購
- `auditLogs`：不可修改或刪除的操作紀錄
- `users.permissions`：各功能的細分操作權限
- `receipts`：每一次實際入帳的獨立收款紀錄；同一筆請款可分次收款
- `expenses`／`companyExpenses`：新增廠商請款、預計付款與實際付款欄位

請將 Firebase Console「Firestore Database → 規則」目前內容全部替換為下方完整版本，再按「發布」。

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

    function userRole() {
      return isSignedIn() ? userData().role : null;
    }

    function isAdmin() {
      return userRole() == "admin";
    }

    function isLegacyEditor() {
      return userRole() == "editor" && !("permissions" in userData());
    }

    function canCreateProjects() {
      return isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.createProjects == true);
    }

    function canEditProjects() {
      return isAdmin() ||
        (("permissions" in userData()) && userData().permissions.editProjects == true);
    }

    function canManageQuotations() {
      return isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageQuotations == true);
    }

    function canManagePayments() {
      return isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.managePayments == true);
    }

    function canManageExpenses() {
      return isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageExpenses == true);
    }

    function canManageCompanyExpenses() {
      return isAdmin() ||
        (userRole() == "editor" && (!("permissions" in userData()) || !("manageCompanyExpenses" in userData().permissions))) ||
        (("permissions" in userData()) && userData().permissions.manageCompanyExpenses == true);
    }

    function canCreateEquipment() {
      return isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.createEquipment == true);
    }

    function canEditEquipment() {
      return isAdmin() ||
        (("permissions" in userData()) && userData().permissions.editEquipment == true);
    }

    function canManageCustomers() {
      return isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageCustomers == true);
    }

    function canManageCatalog() {
      return isAdmin() || isLegacyEditor() ||
        (("permissions" in userData()) && userData().permissions.manageCatalog == true);
    }

    function canViewAudit() {
      return isAdmin() ||
        (("permissions" in userData()) && userData().permissions.viewAudit == true);
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

      allow create: if isSignedIn() && request.auth.uid == userId &&
        request.resource.data.role == "viewer";

      allow update: if isSignedIn() && (
        (request.auth.uid == userId &&
          request.resource.data.diff(resource.data).changedKeys().hasOnly(["updatedAt", "displayName", "email"])) ||
        (isAdmin() && request.resource.data.role in ["admin", "editor", "viewer"])
      );

      allow delete: if false;
    }

    match /projects/{projectId} {
      allow get, list: if isSignedIn();
      allow create: if canCreateProjects() && validProjectData();
      allow update: if canEditProjects() && validProjectData();
      allow delete: if isAdmin();
    }

    match /equipment/{equipmentId} {
      allow get, list: if isSignedIn();
      allow create: if canCreateEquipment() && validEquipmentData();
      allow update: if canEditEquipment() && validEquipmentData();
      allow delete: if isAdmin();
    }

    match /customers/{customerId} {
      allow get, list: if isSignedIn();
      allow create, update: if canManageCustomers();
      allow delete: if isAdmin();
    }

    match /quotationItems/{itemId} {
      allow get, list: if isSignedIn();
      allow create, update: if canManageCatalog();
      allow delete: if isAdmin();
    }

    match /quotations/{quotationId} {
      allow get, list: if isSignedIn();
      allow create, update: if canManageQuotations();
      allow delete: if isAdmin();
    }

    match /payments/{paymentId} {
      allow get, list: if isSignedIn();
      allow create, update: if canManagePayments() && validPaymentData();
      allow delete: if isAdmin();
    }

    match /receipts/{receiptId} {
      allow get, list: if isSignedIn();
      allow create, update: if canManagePayments() && validReceiptData();
      allow delete: if isAdmin();
    }

    match /expenses/{expenseId} {
      allow get, list: if isSignedIn();
      allow create, update: if canManageExpenses() && validExpenseData();
      allow delete: if isAdmin();
    }

    match /companyExpenses/{expenseId} {
      allow get, list: if isSignedIn();
      allow create, update: if canManageCompanyExpenses() && validCompanyExpenseData();
      allow delete: if isAdmin();
    }

    match /auditLogs/{logId} {
      allow get, list: if isSignedIn() && canViewAudit();
      allow create: if isSignedIn() && validAuditData();
      allow update, delete: if false;
    }

    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

## 權限相容性

- 舊的 `admin`：仍保有全部權限。
- 舊的 `editor`：在尚未透過「系統管理」儲存細分權限前，維持第二階段原有權限。
- 已儲存舊版細分權限的 `editor`：新增的「公司支出」權限預設開放；admin 再次儲存後可個別關閉。
- 舊的 `viewer`：維持只看資料。
- admin 在「系統管理」儲存某位使用者後，該使用者改採逐項權限。
- 操作紀錄從第三階段上線後才開始累積，不會偽造過去的歷史紀錄。
