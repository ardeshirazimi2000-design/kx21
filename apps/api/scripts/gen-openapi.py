"""Generates apps/api/openapi.yaml from a compact endpoint table.

Usage: python3 apps/api/scripts/gen-openapi.py apps/api/openapi.yaml
Keep the table in sync when adding routes (CI does not enforce it).
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
ref = lambda n: {"$ref": f"#/components/schemas/{n}"}

schemas = {
    "Error": S(error=S(code=str_, message=str_, details={"type": "array", "items": S(path=str_, message=str_)})),
    "Paged": S(items={"type": "array", "items": {"type": "object"}}, total=int_, page=int_, pageSize=int_),
    "Tokens": S(accessToken=str_, refreshToken=str_),
    "QuorumRule": S(type={"type": "string", "enum": ["majority", "percent", "fixed", "two_thirds"]}, value={"type": "number"}, countProxy=bool_, countOnline=bool_),
    "CommissionSettings": S(
        quorum=ref("QuorumRule"),
        requireQuorumForVoting=bool_,
        requireQuorumToStart=bool_,
        allowProxy=bool_,
        secretVoteDefault=bool_,
        resultVisibility={"type": "string", "enum": ["invitees", "officers"]},
        passRule={"type": "string", "enum": ["majority_of_present", "majority_of_cast", "simple_majority", "two_thirds_of_present"]},
        allowParallelAgenda=bool_,
        allowComments=bool_,
        dueSoonDays=int_,
    ),
    "MeetingStatus": {"type": "string", "enum": ["draft", "scheduled", "invitation_sent", "checkin_open", "in_progress", "agenda_processing", "minutes_draft", "pending_approval", "approved", "archived", "cancelled"]},
    "AttendanceStatus": {"type": "string", "enum": ["pending", "present", "online", "proxy", "manual_present", "absent", "excused"]},
    "Quorum": S(eligible=int_, present=int_, required=int_, reached=bool_, attendingTotal=int_, explanation=str_, breakdown={"type": "object", "additionalProperties": int_}),
    "Attendance": S(user_id=uuid, full_name=str_, role=str_, has_vote=bool_, status=ref("AttendanceStatus"), method=str_, checked_in_at=dt, proxy_name=str_, note=str_),
    "VoteResult": S(counts={"type": "object", "additionalProperties": int_}, totalCast=int_, eligiblePresent=int_, participationPercent={"type": "number"}, passed=bool_, passRule=str_, summary=str_, quorumReached=bool_),
    "MeetingCreate": {
        "type": "object",
        "required": ["commissionId", "title", "scheduledAt"],
        "properties": {
            "commissionId": uuid, "number": int_, "title": str_, "scheduledAt": dt, "durationMinutes": int_, "location": str_, "onlineLink": str_,
            "type": {"type": "string", "enum": ["in_person", "online", "hybrid"]}, "inviteAllMembers": bool_, "schedule": bool_,
            "invitees": {"type": "array", "items": S(userId=uuid, role=str_, hasVote=bool_)},
            "agenda": {"type": "array", "items": S(title=str_, description=str_, priority=str_, durationMinutes=int_, presenterId=uuid, issueId=uuid)},
        },
    },
    "MeetingDetail": S(
        id=uuid, number=int_, title=str_, status=ref("MeetingStatus"), scheduled_at=dt, settings=ref("CommissionSettings"),
        capabilities={"type": "array", "items": str_}, availableActions={"type": "array", "items": str_}, checkinOpen=bool_,
        my=S(role=str_, hasVote=bool_, attendance=ref("Attendance")), invitees={"type": "array", "items": ref("Attendance")},
        quorum=ref("Quorum"), agenda={"type": "array", "items": {"type": "object"}}, votes={"type": "array", "items": {"type": "object"}},
        minutes={"type": "object"}, documents={"type": "array", "items": {"type": "object"}},
    ),
    "ResolutionCreate": {
        "type": "object", "required": ["commissionId", "text"],
        "properties": {"commissionId": uuid, "meetingId": uuid, "agendaItemId": uuid, "voteSessionId": uuid, "text": str_, "ownerId": uuid, "addressee": str_, "dueDate": date, "priority": {"type": "string", "enum": ["low", "normal", "high", "urgent"]}, "kpi": str_},
    },
}

# (method, path, tag, summary, body, notes)
E = [
    ("post", "/api/auth/login", "Auth", "ورود با ایمیل/موبایل و رمز", S(identifier=str_, password=str_, device=str_), "If MFA is enabled returns {mfaRequired, mfaToken}. Rate limited."),
    ("post", "/api/auth/mfa/verify", "Auth", "تکمیل ورود دومرحله‌ای", S(mfaToken=str_, code=str_), None),
    ("post", "/api/auth/refresh", "Auth", "تمدید توکن (rotation)", S(refreshToken=str_), "Reuse of a rotated token revokes all sessions of the user."),
    ("post", "/api/auth/logout", "Auth", "خروج", S(refreshToken=str_), None),
    ("get", "/api/auth/me", "Auth", "پروفایل، نقش‌ها و عضویت‌های کاربر جاری", None, None),
    ("post", "/api/auth/password", "Auth", "تغییر رمز عبور", S(currentPassword=str_, newPassword=str_), None),
    ("post", "/api/auth/mfa/setup", "Auth", "ایجاد کلید TOTP", None, None),
    ("post", "/api/auth/mfa/enable", "Auth", "فعال‌سازی MFA", S(code=str_), None),
    ("post", "/api/auth/devices", "Auth", "ثبت توکن Push دستگاه", S(pushToken=str_, platform=str_), None),

    ("get", "/api/chambers", "Structure", "فهرست اتاق‌های قابل مشاهده", None, None),
    ("post", "/api/chambers", "Structure", "ایجاد اتاق (Super Admin)", S(name=str_, province=str_, phone=str_, email=str_, address=str_), None),
    ("get", "/api/chambers/{id}", "Structure", "جزئیات اتاق", None, None),
    ("patch", "/api/chambers/{id}", "Structure", "ویرایش اتاق", S(name=str_, province=str_, settings={"type": "object"}), None),
    ("post", "/api/chambers/{id}/admins", "Structure", "تعیین مدیر استانی اتاق (Super Admin)", S(userId=uuid, person=S(fullName=str_, email=str_, mobile=str_, password=str_)), "Existing person of the same chamber (userId) or a new person created in the chamber."),
    ("delete", "/api/chambers/{id}/admins/{userId}", "Structure", "حذف مدیر اتاق (Super Admin)", None, None),
    ("get", "/api/terms", "Structure", "دوره‌های یک اتاق (?chamberId)", None, None),
    ("post", "/api/terms", "Structure", "ایجاد دوره", S(chamberId=uuid, number=int_, title=str_, startDate=date, endDate=date, status=str_), "Activating a term closes the previous active term and ends its memberships (history kept)."),
    ("patch", "/api/terms/{id}", "Structure", "ویرایش/فعال‌سازی دوره", S(title=str_, status=str_), None),
    ("get", "/api/commissions", "Structure", "فهرست کمیسیون‌ها (?chamberId&termId&q&page)", None, None),
    ("post", "/api/commissions", "Structure", "ایجاد کمیسیون", S(chamberId=uuid, termId=uuid, name=str_, code=str_, domain=str_, settings=ref("CommissionSettings")), None),
    ("get", "/api/commissions/{id}", "Structure", "جزئیات کمیسیون + capabilities کاربر", None, None),
    ("patch", "/api/commissions/{id}", "Structure", "ویرایش کمیسیون و قواعد نصاب/رأی", S(name=str_, status=str_, settings=ref("CommissionSettings")), None),
    ("get", "/api/commissions/{id}/members", "Structure", "اعضا و سمت‌ها (?includeEnded)", None, None),
    ("post", "/api/commissions/{id}/members", "Structure", "افزودن عضو", S(userId=uuid, person={"type": "object"}, position=str_, hasVote=bool_, startDate=date, replaceExisting=bool_), "409 position_taken when an officer seat is occupied (use replaceExisting)."),
    ("patch", "/api/memberships/{id}", "Structure", "تغییر سمت (پایان رکورد قبلی + رکورد جدید)", S(position=str_, hasVote=bool_), None),
    ("post", "/api/memberships/{id}/end", "Structure", "پایان عضویت", S(endDate=date, reason=str_), None),
    ("get", "/api/people", "Structure", "جستجوی اشخاص (?chamberId&q)", None, None),
    ("post", "/api/people", "Structure", "ثبت شخص", S(chamberId=uuid, nationalId=str_, birthDate=str_, fullName=str_, mobile=str_, email=str_, organization=str_, password=str_), "With nationalId + birthDate the official name is taken from the identity service; IDENTITY_REQUIRED=true makes it mandatory."),
    ("post", "/api/identity/inquiry", "Structure", "استعلام هویت از ثبت احوال (کد ملی + تاریخ تولد)", S(chamberId=uuid, nationalCode=str_, birthDate=str_), "Officers/admins of the chamber only; rate limited; every lookup is audited. 422 identity_not_found, 502 identity_unavailable."),
    ("post", "/api/people/{id}/verify-identity", "Structure", "تأیید هویت شخص موجود", S(nationalCode=str_, birthDate=str_), None),
    ("get", "/api/people/{id}", "Structure", "مشخصات و سوابق عضویت", None, None),
    ("patch", "/api/people/{id}", "Structure", "ویرایش/غیرفعال‌سازی شخص", S(fullName=str_, isActive=bool_, password=str_), None),

    ("get", "/api/roles", "Roles", "نقش‌ها و دسترسی‌های اتاق (?chamberId) — مدیر اتاق", None, None),
    ("get", "/api/roles/options", "Roles", "نقش‌های تعریف‌شده اتاق برای انتخاب سمت", None, None),
    ("post", "/api/roles", "Roles", "تعریف نقش جدید", S(chamberId=uuid, title=str_, description=str_, hasVote=bool_, capabilities={"type": "array", "items": str_}), None),
    ("put", "/api/roles/{key}", "Roles", "تعیین دسترسی‌های یک نقش", S(chamberId=uuid, capabilities={"type": "array", "items": str_}), None),
    ("patch", "/api/roles/{key}", "Roles", "ویرایش نقش تعریف‌شده", S(chamberId=uuid, title=str_, hasVote=bool_), None),
    ("delete", "/api/roles/{key}", "Roles", "حذف نقش تعریف‌شده (?chamberId)", None, "409 role_in_use"),
    ("post", "/api/roles/{key}/reset", "Roles", "بازگردانی دسترسی پیش‌فرض نقش پایه", S(chamberId=uuid), None),
    ("get", "/api/meetings", "Meetings", "تقویم/فهرست جلسات (?commissionId&from&to&status&mine&q)", None, None),
    ("post", "/api/meetings", "Meetings", "ایجاد جلسه با مدعوین و دستور جلسه", ref("MeetingCreate"), None),
    ("get", "/api/meetings/{id}", "Meetings", "جزئیات جلسه (Meeting Room)", None, "Response: MeetingDetail. Members get a quorum summary; officers get full attendance."),
    ("patch", "/api/meetings/{id}", "Meetings", "ویرایش زمان/مکان (اعلان فوری تغییر)", S(title=str_, scheduledAt=dt, location=str_, onlineLink=str_), None),
    ("post", "/api/meetings/{id}/invitees", "Meetings", "افزودن مدعو", S(userId=uuid, role=str_, hasVote=bool_), None),
    ("delete", "/api/meetings/{id}/invitees/{userId}", "Meetings", "حذف مدعو", None, None),
    ("post", "/api/meetings/{id}/schedule", "Meetings", "Draft → Scheduled", None, None),
    ("post", "/api/meetings/{id}/invite", "Meetings", "ارسال دعوت‌نامه (Push/SMS/Email/In-app)", None, None),
    ("post", "/api/meetings/{id}/checkin/open", "Attendance", "باز کردن اعلام حضور", None, None),
    ("post", "/api/meetings/{id}/checkin/close", "Attendance", "بستن اعلام حضور", None, None),
    ("post", "/api/meetings/{id}/check-in", "Attendance", "اعلام حضور عضو (idempotent)", S(method={"type": "string", "enum": ["app", "web", "online"]}, proxyName=str_), "201 on first check-in, 200 on repeat (same timestamp). 409 checkin_closed."),
    ("get", "/api/meetings/{id}/attendance", "Attendance", "لیست حاضرین و نصاب", None, None),
    ("post", "/api/meetings/{id}/attendance/{memberId}/confirm", "Attendance", "ثبت/اصلاح حضور توسط دبیر (دلیل الزامی)", S(status=ref("AttendanceStatus"), reason=str_, proxyName=str_), None),
    ("get", "/api/meetings/{id}/quorum", "Attendance", "محاسبه حد نصاب", None, None),
    ("get", "/api/meetings/{id}/ics", "Meetings", "فایل تقویم (iCalendar)", None, None),
    ("post", "/api/meetings/{id}/delegates", "Meetings", "معرفی نماینده برای یک مدعو (توسط خود مدعو یا دبیر)", S(principalId=uuid, delegateUserId=uuid, person=S(nationalId=str_, birthDate=str_, mobile=str_, fullName=str_), letterDocumentId=uuid, note=str_), "Returns a one-time temporary password when the representative has no account."),
    ("delete", "/api/meetings/{id}/delegates/{delegationId}", "Meetings", "لغو نماینده", S(reason=str_), None),
    ("post", "/api/meetings/{id}/start", "Live", "شروع رسمی جلسه", None, "409 quorum_not_reached when requireQuorumToStart."),
    ("post", "/api/meetings/{id}/end", "Live", "پایان جلسه و تولید پیش‌نویس صورتجلسه", None, "409 vote_open."),
    ("post", "/api/meetings/{id}/cancel", "Meetings", "لغو جلسه با دلیل", S(reason=str_), None),
    ("post", "/api/meetings/{id}/archive", "Meetings", "بایگانی", None, None),
    ("post", "/api/meetings/{id}/agenda", "Agenda", "افزودن آیتم دستور جلسه", S(title=str_, description=str_, priority=str_, presenterId=uuid, issueId=uuid), None),
    ("post", "/api/meetings/{id}/agenda/reorder", "Agenda", "ترتیب آیتم‌ها", S(ids={"type": "array", "items": uuid}), None),
    ("post", "/api/meetings/{id}/agenda/{itemId}/activate", "Live", "فعال‌سازی آیتم دستور جلسه", None, None),
    ("patch", "/api/agenda-items/{id}", "Agenda", "ویرایش آیتم/ثبت خلاصه مذاکرات و تصمیم", S(title=str_, discussionSummary=str_, decision=str_, proposedResolution=str_), None),
    ("delete", "/api/agenda-items/{id}", "Agenda", "حذف (soft) آیتم", S(reason=str_), None),
    ("post", "/api/agenda-items/{id}/complete", "Live", "خاتمه آیتم: done | referred | removed", S(status=str_, discussionSummary=str_, decision=str_, referral=S(expertId=uuid, request=str_, dueDate=date)), None),
    ("get", "/api/agenda-items/{id}/comments", "Agenda", "نظرات آیتم", None, None),
    ("post", "/api/agenda-items/{id}/comments", "Agenda", "ثبت نظر", S(body=str_), None),
    ("post", "/api/agenda-items/{id}/vote/start", "Voting", "شروع رأی‌گیری", S(title=str_, secret=bool_, options={"type": "array", "items": str_}, passRule=str_), "409 quorum_not_reached / item_not_active / vote_open."),
    ("post", "/api/agenda-items/{id}/vote", "Voting", "ثبت رأی", S(choice=str_, voteSessionId=uuid), "409 already_voted / vote_closed; 403 when not checked in or no voting right."),
    ("post", "/api/agenda-items/{id}/vote/close", "Voting", "پایان رأی‌گیری و محاسبه نتیجه", None, "Response: {id, status, result: VoteResult}"),
    ("post", "/api/vote-sessions/{id}/close", "Voting", "پایان رأی‌گیری (با شناسه)", None, None),
    ("get", "/api/vote-sessions/{id}", "Voting", "وضعیت/نتیجه رأی‌گیری", None, "voters only for non-secret closed votes."),
    ("post", "/api/vote-sessions/{id}/corrections", "Voting", "اصلاح رسمی پس از بسته‌شدن (ابطال رأی)", S(voterId=uuid, reason=str_), None),
    ("get", "/api/meetings/{id}/minutes", "Minutes", "صورتجلسه", None, None),
    ("post", "/api/meetings/{id}/minutes", "Minutes", "ذخیره نسخه جدید / تولید مجدد", S(body=str_, regenerate=bool_), None),
    ("post", "/api/minutes/{id}/submit", "Minutes", "ارسال برای تأیید رئیس", None, None),
    ("post", "/api/minutes/{id}/return", "Minutes", "برگشت برای اصلاح", S(reason=str_), None),
    ("post", "/api/minutes/{id}/approve", "Minutes", "تأیید و قفل (شماره + هش)", None, None),
    ("post", "/api/resolutions", "Resolutions", "ایجاد مصوبه (+Task)", ref("ResolutionCreate"), None),
    ("get", "/api/resolutions", "Resolutions", "فهرست مصوبات (?commissionId&status&mine&overdue&q)", None, None),
    ("get", "/api/resolutions/{id}", "Resolutions", "جزئیات مصوبه، تاریخچه و مستندات", None, None),
    ("patch", "/api/resolutions/{id}", "Resolutions", "ویرایش/لغو مصوبه", S(text=str_, ownerId=uuid, dueDate=date, status=str_), None),
    ("patch", "/api/resolutions/{id}/progress", "Resolutions", "ثبت پیشرفت توسط مسئول اجرا", S(progress=int_, note=str_, documentId=uuid, submit=bool_), None),
    ("post", "/api/resolutions/{id}/review", "Resolutions", "تأیید یا برگشت نتیجه توسط دبیر", S(approve=bool_, note=str_), None),
    ("get", "/api/tasks", "Resolutions", "وظایف باز من", None, None),
    ("get", "/api/commissions/{id}/issues", "Issues", "مسائل کمیسیون", None, None),
    ("post", "/api/commissions/{id}/issues", "Issues", "ثبت مسئله", S(title=str_, description=str_), None),
    ("patch", "/api/issues/{id}", "Issues", "ویرایش مسئله", S(status=str_), None),
    ("post", "/api/referrals", "Issues", "ارجاع کارشناسی", S(commissionId=uuid, issueId=uuid, expertId=uuid, request=str_, dueDate=date), None),
    ("get", "/api/referrals", "Issues", "ارجاعات (کارشناس: ارجاعات خود؛ ?commissionId برای دبیر)", None, None),
    ("post", "/api/referrals/{id}/answer", "Issues", "پاسخ کارشناس", S(response=str_), None),
    ("post", "/api/documents", "Documents", "بارگذاری سند (multipart: file + meetingId|agendaItemId|resolutionId|issueId|commissionId)", None, "Type/extension/magic-byte validated, size limited, malware scan hook."),
    ("get", "/api/documents", "Documents", "فهرست اسناد", None, None),
    ("get", "/api/documents/{id}/download", "Documents", "دریافت سند", None, None),
    ("post", "/api/documents/{id}/link", "Documents", "لینک امضاشده کوتاه‌مدت برای موبایل", None, None),
    ("get", "/api/files/{id}", "Documents", "دریافت سند با لینک امضاشده (?token) — بدون Bearer", None, "Token valid for 2 minutes; access is re-checked."),
    ("get", "/api/me/home", "Dashboard", "خانه من (موبایل)", None, None),
    ("get", "/api/notifications", "Notifications", "اعلان‌ها (?unread)", None, None),
    ("post", "/api/notifications/{id}/read", "Notifications", "خوانده شد", None, None),
    ("post", "/api/notifications/read-all", "Notifications", "خواندن همه", None, None),
    ("get", "/api/dashboard/commission", "Dashboard", "داشبورد کمیسیون (?commissionId)", None, None),
    ("get", "/api/dashboard/chamber", "Dashboard", "داشبورد اتاق (?chamberId)", None, None),
    ("get", "/api/reports/resolutions", "Reports", "گزارش مصوبات (?format=csv)", None, None),
    ("get", "/api/reports/attendance", "Reports", "گزارش حضور اعضا (?commissionId)", None, None),
    ("get", "/api/search", "Reports", "جستجوی سراسری (?q)", None, None),
    ("get", "/api/audit", "Audit", "رویدادنگاری (?chamberId&entity&entityId&action)", None, None),
    ("get", "/api/audit/verify", "Audit", "بررسی سلامت زنجیره هش", None, None),
]

paths = {}
for method, path, tag, summary, body, notes in E:
    op = {"tags": [tag], "summary": summary, "responses": {
        "200": {"description": "OK"},
        "400": {"description": "Validation error", "content": {"application/json": {"schema": ref("Error")}}},
        "401": {"description": "Unauthenticated"},
        "403": {"description": "Forbidden"},
        "404": {"description": "Not found or not visible"},
        "409": {"description": "Conflict (state machine / business rule)", "content": {"application/json": {"schema": ref("Error")}}},
    }}
    if notes:
        op["description"] = notes
    if path.startswith("/api/files/"):
        op["security"] = []
    if path.startswith("/api/auth/") and path not in ("/api/auth/me", "/api/auth/password", "/api/auth/mfa/setup", "/api/auth/mfa/enable", "/api/auth/devices"):
        op["security"] = []
    if body is not None:
        op["requestBody"] = {"required": True, "content": {"application/json": {"schema": body}}}
    if path == "/api/documents" and method == "post":
        op["requestBody"] = {"required": True, "content": {"multipart/form-data": {"schema": S(file={"type": "string", "format": "binary"}, meetingId=uuid, agendaItemId=uuid, resolutionId=uuid, issueId=uuid, commissionId=uuid, kind=str_, title=str_)}}}
    if path == "/api/meetings/{id}" and method == "get":
        op["responses"]["200"] = {"description": "OK", "content": {"application/json": {"schema": ref("MeetingDetail")}}}
    if path.endswith("/login") or path.endswith("/refresh") or path.endswith("/mfa/verify"):
        op["responses"]["200"] = {"description": "OK", "content": {"application/json": {"schema": ref("Tokens")}}}
    params = []
    for seg in path.split("/"):
        if seg.startswith("{"):
            params.append({"name": seg[1:-1], "in": "path", "required": True, "schema": str_ if seg == "{key}" else uuid})
    if params:
        op["parameters"] = params
    paths.setdefault(path, {})[method] = op

doc = {
    "openapi": "3.1.0",
    "info": {
        "title": "Chamber Commissions API — سامانه کمیسیون‌های تخصصی",
        "version": "1.0.0",
        "description": (
            "REST API of the commissions platform. All business endpoints require `Authorization: Bearer <accessToken>`.\n\n"
            "Real-time: Socket.IO at `/socket.io` (auth: `{ token }`). Emit `meeting:join` with a meeting id, then receive "
            "`meeting.updated`, `attendance.updated` (officers), `quorum.updated`, `agenda.updated`, `comment.created`, "
            "`vote.opened`, `vote.progress`, `vote.closed`, and personal `notification` events.\n\n"
            "Errors: `{ error: { code, message, details? } }` with Persian messages."
        ),
    },
    "servers": [{"url": "http://localhost:4000"}],
    "security": [{"bearer": []}],
    "components": {"securitySchemes": {"bearer": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}}, "schemas": schemas},
    "paths": paths,
}
with open(out, "w", encoding="utf-8") as f:
    yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False, width=140)
print(len(E), "operations")
