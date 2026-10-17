"""Generates apps/office-api/openapi.yaml from a compact endpoint table.

Usage: python3 apps/office-api/scripts/gen-openapi.py apps/office-api/openapi.yaml
Keep the table in sync when adding routes.
"""
import sys
import yaml

out = sys.argv[1]

S = lambda **props: {"type": "object", "properties": props}
str_ = {"type": "string"}
uuid = {"type": "string", "format": "uuid"}
date = {"type": "string", "format": "date", "example": "2026-10-20"}
dt = {"type": "string", "format": "date-time"}
int_ = {"type": "integer"}
bool_ = {"type": "boolean"}
arr = lambda item: {"type": "array", "items": item}
enum = lambda *v: {"type": "string", "enum": list(v)}
ref = lambda n: {"$ref": f"#/components/schemas/{n}"}

assignee = S(kind=enum("user", "position", "role", "unit_manager", "owner_unit_manager", "initiator_manager", "context_user"), value=str_)
schemas = {
    "Error": S(error=S(code=str_, message=str_, details=arr(S(path=str_, message=str_)))),
    "Paged": S(items=arr({"type": "object"}), total=int_, page=int_, pageSize=int_),
    "Tokens": S(accessToken=str_, refreshToken=str_, mfaRequired=bool_, mfaToken=str_),
    "Recipient": S(userId=uuid, positionId=uuid, unitId=uuid, kind=enum("to", "cc")),
    "LetterCreate": {
        "type": "object",
        "required": ["kind", "subject"],
        "properties": {
            "kind": enum("incoming", "outgoing", "internal"), "subject": str_, "body": str_, "summary": str_, "externalParty": str_, "externalOrg": str_,
            "externalNumber": str_, "externalDate": date, "source": enum("manual", "email", "scan", "api"), "deliveryMethod": str_,
            "priority": enum("low", "normal", "high", "urgent"), "confidentiality": {"type": "integer", "minimum": 0, "maximum": 2}, "ownerUnitId": uuid,
            "replyToId": uuid, "dueDate": date, "recipients": arr(ref("Recipient")), "register": bool_, "workflow": {"type": "string", "description": "workflow definition key to start"},
            "bodyFormat": {**enum("text", "html"), "description": "html: body from the letter editor, sanitised server-side"}, "templateId": uuid,
            "signatoryId": {**uuid, "description": "designated signatory (needs letter.sign); only they can sign"},
        },
    },
    "WorkflowStep": S(
        key=str_, name=str_, type=enum("review", "approve", "sign", "archive", "notify"), assignee=assignee, slaHours={"type": "number"},
        remindBeforeHours={"type": "number"}, escalateTo=assignee, onReject={"type": "string", "description": "'end' or a previous step key"},
        condition=S(field=enum("priority", "kind", "confidentiality", "source"), op=enum("eq", "neq", "in"), value={}), archiveFolderId=uuid,
    ),
    "WorkflowDefinition": S(
        key=str_, name=str_, description=str_, appliesTo=arr(enum("incoming", "outgoing", "internal")),
        definition=S(steps=arr(ref("WorkflowStep")), completeStatus=enum("approved", "signed", "archived")),
    ),
    "RouteTargets": S(
        targets=arr(S(userId=uuid, positionId=uuid, action=enum("refer", "review", "approve", "sign", "archive", "info", "follow_up"), instruction=str_, dueAt=dt)),
        parentId=uuid, completeMine=bool_,
    ),
    "EventEnvelope": S(id=str_, type=enum("resolution.created", "resolution.updated", "meeting.updated", "referral.updated", "integration.ping"), occurredAt=dt, data=S(id=str_)),
}

multipart_file = lambda **extra: {"multipart/form-data": {"schema": S(file={"type": "string", "format": "binary"}, **extra)}}

# (method, path, tag, summary, body, notes)
E = [
    ("post", "/api/auth/login", "Auth", "ورود (نام کاربری، ایمیل یا موبایل)", S(identifier=str_, password=str_), "Returns tokens, or { mfaRequired, mfaToken } when TOTP is enabled."),
    ("post", "/api/auth/mfa/verify", "Auth", "تکمیل ورود دومرحله‌ای", S(mfaToken=str_, code=str_), None),
    ("post", "/api/auth/refresh", "Auth", "تمدید توکن (چرخشی؛ استفاده مجدد کل نشست را باطل می‌کند)", S(refreshToken=str_), None),
    ("post", "/api/auth/logout", "Auth", "خروج", S(refreshToken=str_), None),
    ("get", "/api/auth/me", "Auth", "کاربر جاری با نقش‌ها، مجوزها و سمت‌ها", None, None),
    ("post", "/api/auth/password", "Auth", "تغییر رمز عبور", S(currentPassword=str_, newPassword=str_), None),
    ("post", "/api/auth/mfa/setup", "Auth", "شروع فعال‌سازی TOTP (secret، otpauth و QR)", None, None),
    ("post", "/api/auth/mfa/enable", "Auth", "تأیید و فعال‌سازی TOTP", S(code=str_), None),

    ("get", "/api/org/units", "Organization", "واحدها و سمت‌ها (با متصدیان)", None, None),
    ("post", "/api/org/units", "Organization", "واحد جدید [org.manage]", S(name=str_, code=str_, parentId=uuid, kind=str_), None),
    ("patch", "/api/org/units/{id}", "Organization", "ویرایش واحد [org.manage]", S(name=str_, code=str_, parentId=uuid, kind=str_, isActive=bool_), None),
    ("post", "/api/org/positions", "Organization", "سمت جدید [org.manage]", S(unitId=uuid, title=str_, parentId=uuid, isManager=bool_), None),
    ("patch", "/api/org/positions/{id}", "Organization", "ویرایش سمت [org.manage]", S(unitId=uuid, title=str_, isManager=bool_), None),
    ("get", "/api/users/directory", "Organization", "فهرست کاربران برای انتخاب (?q)", None, None),
    ("get", "/api/users", "Organization", "کاربران [users.manage]", None, None),
    ("post", "/api/users", "Organization", "کاربر جدید با سمت‌ها و نقش‌ها [users.manage]", S(username=str_, fullName=str_, nationalId=str_, email=str_, mobile=str_, password=str_, clearance=int_, positions=arr(S(positionId=uuid, isPrimary=bool_)), roles=arr(S(roleId=uuid, scopeUnitId=uuid))), None),
    ("patch", "/api/users/{id}", "Organization", "ویرایش کاربر / بازنشانی 2FA [users.manage]", S(fullName=str_, isActive=bool_, clearance=int_, resetMfa=bool_), None),
    ("get", "/api/roles", "Organization", "نقش‌ها و فهرست مجوزها", None, None),
    ("post", "/api/roles", "Organization", "نقش جدید [roles.manage]", S(key=str_, name=str_, description=str_, permissions=arr(str_)), None),
    ("patch", "/api/roles/{id}", "Organization", "ویرایش مجوزهای نقش [roles.manage]", S(name=str_, permissions=arr(str_)), None),

    ("get", "/api/letters", "Correspondence", "جستجوی نامه‌ها (?q&kind&status&priority&box&from&to&unitId&number&party&source&page)", None, "Full-text search (Persian-normalised) over subject, body, summary, parties and numbers; results are filtered by RBAC + ABAC visibility."),
    ("post", "/api/letters", "Correspondence", "ایجاد نامه (پیش‌نویس یا ثبت فوری؛ با شروع گردش کار)", ref("LetterCreate"), None),
    ("get", "/api/letters/{id}", "Correspondence", "جزئیات نامه با ارجاعات، گردش‌ها، امضاها و اقدام‌های مجاز (my)", None, None),
    ("patch", "/api/letters/{id}", "Correspondence", "ویرایش (فقط پیش‌نویس/ثبت‌شده و امضانشده)", ref("LetterCreate"), None),
    ("post", "/api/letters/{id}/register", "Correspondence", "ثبت و شماره‌گذاری خودکار (و/ص/د/سال/ردیف)", None, None),
    ("post", "/api/letters/{id}/attachments", "Correspondence", "افزودن پیوست یا نسخه جدید (groupId)", None, None),
    ("get", "/api/letters/{id}/attachments/{attId}/download", "Correspondence", "دریافت پیوست (?inline=1)", None, None),
    ("get", "/api/letters/{id}/barcode.svg", "Correspondence", "بارکد Code128 کد رهگیری", None, None),
    ("get", "/api/letters/{id}/qr.svg", "Correspondence", "کد QR صفحه صحت‌سنجی", None, None),
    ("get", "/api/letters/lookup/{code}", "Correspondence", "یافتن نامه با اسکن بارکد", None, None),
    ("post", "/api/letters/{id}/routes", "Correspondence", "ارجاع به کاربر یا سمت", ref("RouteTargets"), None),
    ("patch", "/api/routes/{id}", "Correspondence", "پاسخ به ارجاع (seen/done/returned)", S(status=enum("seen", "done", "returned"), response=str_), None),
    ("get", "/api/cartable", "Correspondence", "کارتابل: ارجاعات و گام‌های گردش کار در انتظار", None, None),
    ("post", "/api/letters/{id}/sign", "Correspondence", "امضای دیجیتال (Ed25519 روی هش محتوا و پیوست‌ها)", None, None),
    ("get", "/api/letters/{id}/signatures/{sigId}/image", "Correspondence", "تصویر امضای ثبت‌شده روی نامه", None, None),
    ("get", "/api/signatures", "Correspondence", "فهرست نمونه امضای کاربران [signatures.manage]", None, None),
    ("get", "/api/users/{id}/signature", "Correspondence", "تصویر نمونه امضای کاربر", None, None),
    ("post", "/api/users/{id}/signature", "Correspondence", "ثبت یا جایگزینی نمونه امضا (PNG/JPEG، حداکثر ۱ مگابایت) [خود کاربر یا signatures.manage]", None, None),
    ("delete", "/api/users/{id}/signature", "Correspondence", "حذف نمونه امضا", None, None),
    ("get", "/api/letter-templates", "Correspondence", "قالب‌ها و سربرگ‌های نامه (?all=1 غیرفعال‌ها هم [templates.manage])", None, None),
    ("post", "/api/letter-templates", "Correspondence", "قالب جدید [templates.manage]", S(name=str_, description=str_, kinds=arr(enum("outgoing", "internal")), unitId=uuid, pageSize=enum("A4", "A5"), headerText=str_, orgName=str_, orgSubtitle=str_, footerText=str_, showLogo=bool_, marginTop=int_, marginBottom=int_, marginSide=int_, fontSize={"type": "number"}, showQr=bool_, bodyHtml=str_, isDefault=bool_, isActive=bool_), "bodyHtml is sanitised to the letter editor's HTML subset."),
    ("get", "/api/letter-templates/{id}", "Correspondence", "قالب نامه", None, None),
    ("patch", "/api/letter-templates/{id}", "Correspondence", "ویرایش قالب [templates.manage]", S(name=str_, isDefault=bool_, isActive=bool_, bodyHtml=str_), "Same fields as POST; omitted fields keep their value, null clears optional text."),
    ("delete", "/api/letter-templates/{id}", "Correspondence", "حذف قالب (قالب استفاده‌شده فقط غیرفعال می‌شود) [templates.manage]", None, "Returns { outcome: deleted | deactivated }."),
    ("post", "/api/letter-templates/{id}/{image}", "Correspondence", "بارگذاری لوگو (image=logo، حداکثر ۲ مگابایت) یا تصویر کامل سربرگ (image=background، حداکثر ۵ مگابایت) [templates.manage]", None, None),
    ("get", "/api/letter-templates/{id}/{image}", "Correspondence", "تصویر لوگو یا سربرگ قالب", None, None),
    ("delete", "/api/letter-templates/{id}/{image}", "Correspondence", "حذف لوگو یا تصویر سربرگ [templates.manage]", None, None),
    ("post", "/api/letters/{id}/send", "Correspondence", "ثبت ارسال نامه صادره", S(deliveryMethod=str_, requireSignature=bool_), None),
    ("post", "/api/letters/{id}/archive", "Correspondence", "بایگانی نامه", S(folderId=uuid), None),
    ("post", "/api/letters/{id}/cancel", "Correspondence", "ابطال", S(reason=str_), None),
    ("get", "/api/verify/{code}", "Correspondence", "صحت‌سنجی عمومی نامه (QR)", None, "Public. Confidential letters reveal only number, date and signature validity."),

    ("get", "/api/workflows", "Workflow", "آخرین نسخه هر فرایند", None, None),
    ("get", "/api/workflows/{key}", "Workflow", "تاریخچه نسخه‌ها", None, None),
    ("post", "/api/workflows", "Workflow", "ذخیره نسخه جدید [workflow.manage]", ref("WorkflowDefinition"), None),
    ("post", "/api/workflows/{key}/activate", "Workflow", "فعال‌سازی نسخه (version) یا غیرفعال‌سازی (null)", S(version=int_), None),
    ("post", "/api/letters/{id}/workflow", "Workflow", "شروع گردش کار روی نامه [workflow.start]", S(definition=str_), None),
    ("post", "/api/workflow-steps/{id}/act", "Workflow", "اقدام روی گام (تأیید/رد)", S(decision=enum("approve", "reject"), comment=str_, archiveFolderId=uuid), "Reject needs a comment; onReject returns to a previous step or ends the workflow."),
    ("get", "/api/workflow-instances/{id}", "Workflow", "جزئیات نمونه گردش", None, None),
    ("post", "/api/workflow-instances/{id}/cancel", "Workflow", "لغو گردش", S(reason=str_), None),

    ("get", "/api/archive/policies", "Archive", "سیاست‌های نگهداری", None, None),
    ("post", "/api/archive/policies", "Archive", "سیاست جدید [archive.dispose]", S(name=str_, retainYears=int_, action=enum("destroy", "review", "permanent"), description=str_), None),
    ("get", "/api/archive/folders", "Archive", "درخت پرونده‌ها", None, None),
    ("post", "/api/archive/folders", "Archive", "پرونده جدید [archive.manage]", S(name=str_, code=str_, parentId=uuid, unitId=uuid, retentionPolicyId=uuid), None),
    ("get", "/api/archive/documents", "Archive", "اسناد (?folderId&recursive&status&due&q)", None, None),
    ("post", "/api/archive/documents", "Archive", "سند جدید (multipart) [archive.manage]", None, None),
    ("get", "/api/archive/documents/{id}", "Archive", "سند با نسخه‌ها و امضاها", None, None),
    ("patch", "/api/archive/documents/{id}", "Archive", "ویرایش / توقیف قانونی", S(title=str_, folderId=uuid, retentionPolicyId=uuid, legalHold=bool_), None),
    ("post", "/api/archive/documents/{id}/versions", "Archive", "نسخه جدید (multipart)", None, None),
    ("get", "/api/archive/versions/{id}/download", "Archive", "دریافت نسخه", None, None),
    ("post", "/api/archive/versions/{id}/sign", "Archive", "امضای دیجیتال نسخه", None, None),
    ("post", "/api/archive/documents/{id}/dispose", "Archive", "امحا [archive.dispose]", S(reason=str_, force=bool_), "Refused before the retention date unless force=true, and always refused under legal hold. File contents are deleted; metadata stays for the audit trail."),

    ("get", "/api/notifications", "Notifications", "اعلان‌های من (?unread)", None, None),
    ("post", "/api/notifications/read", "Notifications", "خوانده‌شدن (ids یا همه)", S(ids=arr(uuid)), None),
    ("get", "/api/notification-templates", "Notifications", "قالب‌ها [notifications.manage]", None, None),
    ("put", "/api/notification-templates/{event}/{channel}", "Notifications", "ویرایش قالب", S(subject=str_, body=str_, enabled=bool_), None),

    ("get", "/api/reports/dashboard", "Reports", "شاخص‌ها (?from&to) [reports.view]", None, None),
    ("get", "/api/reports/export", "Reports", "خروجی Excel/CSV (?report=letters|units|routing&format=xlsx|csv&from&to)", None, None),
    ("get", "/api/audit", "Audit", "رویدادنگاری [audit.view]", None, None),
    ("get", "/api/audit/verify", "Audit", "بررسی زنجیره هش", None, None),

    ("get", "/api/integrations", "Integration", "وضعیت اتصال‌ها [integration.manage]", None, None),
    ("put", "/api/integrations/meetings", "Integration", "تنظیم اتصال به سامانه جلسات", S(baseUrl=str_, clientId=str_, apiKey=str_, webhookSecret=str_, isActive=bool_, settings=S(resolutionWorkflowKey=str_, defaultUnitId=uuid, autoFeedback=bool_, auth=enum("apikey", "oauth2"), poll=bool_)), None),
    ("post", "/api/integrations/meetings/test", "Integration", "آزمایش اتصال", None, None),
    ("post", "/api/integrations/meetings/sync", "Integration", "همگام‌سازی جلسات و رویدادها", None, None),
    ("get", "/api/integrations/meetings/inbox", "Integration", "رویدادهای دریافتی", None, None),
    ("post", "/api/integrations/meetings/webhook", "Integration", "دریافت رویداد از سامانه جلسات (امضای HMAC)", ref("EventEnvelope"), "Public; verified with `x-kx-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + '.' + rawBody)>` (5-minute tolerance). Idempotent by event id."),
    ("put", "/api/integrations/intake", "Integration", "درگاه دریافت نامه؛ rotateKey کلید جدید برمی‌گرداند", S(isActive=bool_, defaultUnitId=uuid, rotateKey=bool_), None),
    ("post", "/api/intake/letters", "Integration", "ثبت نامه وارده از ایمیل/اسکن/سامانه دیگر (X-Api-Key)", S(subject=str_, body=str_, externalOrg=str_, externalParty=str_, externalNumber=str_, externalDate=date, source=enum("email", "scan", "api"), externalRef=str_, attachments=arr(S(fileName=str_, contentBase64=str_))), None),
    ("get", "/api/meetings", "Meetings", "جلسات (کش سامانه جلسات) [meetings.view]", None, None),
    ("get", "/api/meetings/{id}", "Meetings", "جلسه (?refresh=1 دریافت مجدد)", None, None),
    ("post", "/api/meetings/{id}/invitation-letters", "Meetings", "ساخت پیش‌نویس نامه دعوت برای مدعوین [letter.register_outgoing]", S(inviteeIds=arr(uuid), note=str_), "Skips invitees that already have a non-cancelled invitation letter."),
    ("get", "/api/commissions", "Meetings", "کمیسیون‌ها از سامانه جلسات [meetings.refer]", None, None),
    ("get", "/api/resolutions", "Meetings", "مصوبات (?mine&status&q)", None, None),
    ("get", "/api/resolutions/{id}", "Meetings", "مصوبه با گزارش‌های پیگیری", None, None),
    ("post", "/api/resolutions/{id}/feedback", "Meetings", "گزارش اجرا به سامانه جلسات (صف با تلاش مجدد)", S(progress=int_, note=str_, submit=bool_), None),
    ("post", "/api/letters/{id}/meeting-referrals", "Meetings", "ارجاع مکاتبه به کمیسیون [meetings.refer]", S(commissionId=uuid, requestedMeetingId=uuid, note=str_, includeAttachments=bool_), None),
]

PUBLIC = ("/api/auth/login", "/api/auth/mfa/verify", "/api/auth/refresh", "/api/auth/logout", "/api/verify/{code}", "/api/integrations/meetings/webhook", "/api/intake/letters")
paths = {}
for method, path, tag, summary, body, notes in E:
    op = {"tags": [tag], "summary": summary, "responses": {
        "200": {"description": "OK"},
        "400": {"description": "Validation error", "content": {"application/json": {"schema": ref("Error")}}},
        "401": {"description": "Unauthenticated"},
        "403": {"description": "Forbidden"},
        "404": {"description": "Not found or not visible"},
        "409": {"description": "Conflict (state / business rule)", "content": {"application/json": {"schema": ref("Error")}}},
    }}
    if notes:
        op["description"] = notes
    if path in PUBLIC:
        op["security"] = [{"apiKey": []}] if path == "/api/intake/letters" else []
    if body is not None:
        op["requestBody"] = {"required": True, "content": {"application/json": {"schema": body}}}
    if path.endswith("/attachments") or path.endswith("/versions") or path == "/api/archive/documents" and method == "post":
        op["requestBody"] = {"required": True, "content": multipart_file(groupId=uuid, title=str_, folderId=uuid, note=str_)}
    if path in ("/api/users/{id}/signature", "/api/letter-templates/{id}/{image}") and method == "post":
        op["requestBody"] = {"required": True, "content": multipart_file()}
    if path in ("/api/auth/login", "/api/auth/refresh", "/api/auth/mfa/verify"):
        op["responses"]["200"] = {"description": "OK", "content": {"application/json": {"schema": ref("Tokens")}}}
    if method == "get" and path in ("/api/letters", "/api/users", "/api/archive/documents", "/api/notifications", "/api/audit", "/api/meetings", "/api/resolutions"):
        op["responses"]["200"] = {"description": "OK", "content": {"application/json": {"schema": ref("Paged")}}}
    params = [{"name": seg[1:-1], "in": "path", "required": True, "schema": enum("logo", "background") if seg == "{image}" else uuid if seg in ("{id}", "{attId}", "{sigId}") else str_} for seg in path.split("/") if seg.startswith("{")]
    if params:
        op["parameters"] = params
    paths.setdefault(path, {})[method] = op

doc = {
    "openapi": "3.1.0",
    "info": {
        "title": "Office Automation API — اتوماسیون اداری",
        "version": "1.0.0",
        "description": (
            "REST API of the office automation system (correspondence, workflow, archive, users and access, notifications, reports, integration).\n\n"
            "Business endpoints require `Authorization: Bearer <accessToken>`. Errors: `{ error: { code, message, details? } }` with Persian messages. "
            "Lists return `{ items, total, page, pageSize }`. Letters that are not visible to the caller answer 404."
        ),
    },
    "servers": [{"url": "http://localhost:4100"}],
    "security": [{"bearer": []}],
    "components": {
        "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}, "apiKey": {"type": "apiKey", "in": "header", "name": "X-Api-Key"}},
        "schemas": schemas,
    },
    "paths": paths,
}
with open(out, "w", encoding="utf-8") as f:
    yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False, width=140)
print(len(E), "operations")
