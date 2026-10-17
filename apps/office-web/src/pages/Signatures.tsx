import { useState } from "react";
import { SignatureEditor } from "../components/signature";
import {
  Badge,
  Card,
  Empty,
  Loading,
  Modal,
  PageHeader,
  Pager,
  dateTimeFa,
} from "../components/ui";
import { get } from "../lib/api";
import { useApi } from "../lib/hooks";

/** «نمونه امضاها»: the secretariat registers each signer's specimen signature image. */
export function SignaturesPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const qs = `page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const r = useApi<{
    items: any[];
    total: number;
    page: number;
    pageSize: number;
  }>(`/signatures?${qs}`, [qs]);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <PageHeader
        title="نمونه امضاها"
        subtitle="تصویر امضای هر شخص اینجا ثبت می‌شود و هنگام امضای دیجیتال، زیر نامه چاپ می‌شود."
      />
      <Card>
        <input
          className="input mb"
          placeholder="جستجوی نام یا نام کاربری… (Enter)"
          onKeyDown={(e) =>
            e.key === "Enter" &&
            (setQ((e.target as HTMLInputElement).value.trim()), setPage(1))
          }
        />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>شخصی یافت نشد.</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>نام</th>
                  <th>سمت</th>
                  <th>نمونه امضا</th>
                  <th>آخرین تغییر</th>
                </tr>
              </thead>
              <tbody>
                {r.data.items.map((u) => (
                  <tr
                    key={u.id}
                    className="clickable"
                    onClick={() => setEdit(u)}
                  >
                    <td>
                      {u.full_name}{" "}
                      {u.can_sign && <Badge tone="info">امضاکننده</Badge>}
                    </td>
                    <td className="small">{u.positions ?? "—"}</td>
                    <td>
                      {u.has_signature ? (
                        <Badge tone="success">ثبت شده</Badge>
                      ) : (
                        <Badge>ثبت نشده</Badge>
                      )}
                    </td>
                    <td className="small">
                      {u.signature_updated_at
                        ? `${dateTimeFa(u.signature_updated_at)}${u.signature_updated_by ? ` — ${u.signature_updated_by}` : ""}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager
              page={r.data.page}
              pageSize={r.data.pageSize}
              total={Number(r.data.total)}
              onPage={setPage}
            />
          </>
        )}
      </Card>
      {edit && (
        <Modal
          title={`نمونه امضای ${edit.full_name}`}
          onClose={() => setEdit(null)}
        >
          <SignatureEditor
            userId={edit.id}
            hasSignature={edit.has_signature}
            onChange={async () => {
              const fresh = await get<{ items: any[] }>(
                `/signatures?q=${encodeURIComponent(edit.username)}`,
              );
              setEdit(fresh.items.find((x) => x.id === edit.id) ?? edit);
              await r.reload();
            }}
          />
        </Modal>
      )}
    </>
  );
}
