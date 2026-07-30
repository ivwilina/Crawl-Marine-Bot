// ============================================================================
//  INTERFACE (CLI) · Detect HTML drift — kiểm tra VesselFinder có đổi form HTML
//  chưa, KHÔNG spam. Fetch vài ID mẫu (rate ~1 req/2s) rồi so từng selector mà
//  VesselFinderHtmlMapper đang phụ thuộc (logic thuần trong htmlDrift.ts).
//
//  Chạy:  npx ts-node src/interfaces/cli/detectHtmlDrift.ts [id1 id2 ...]
//  Không truyền ID -> dùng bộ mẫu mặc định bên dưới.
// ============================================================================

import { HttpClient } from "../../infrastructure/http/HttpClient";
import { analyzeHtml, DriftResult } from "../../infrastructure/datasources/htmlDrift";

const BASE = "https://www.vesselfinder.com/vessels/details";
const DELAY_MS = 2000; // ~1 req / 2s — an toàn, không phải spam

// Vài ID mẫu (IMO). Đổi tùy ý hoặc truyền qua argv.
const DEFAULT_SAMPLE = ["9384198", "9074729"];

interface PageReport extends DriftResult {
  id: string;
  fetchError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function inspect(http: HttpClient, id: string): Promise<PageReport> {
  let html: string;
  try {
    html = await http.getText(`${BASE}/${id}`);
  } catch (err) {
    return {
      id,
      ok: false,
      failedChecks: [],
      missingLabels: [],
      fetchError: (err as Error).message,
    };
  }
  return { id, ...analyzeHtml(html) };
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  const sample = ids.length > 0 ? ids : DEFAULT_SAMPLE;
  const http = new HttpClient({ timeoutMs: 10000 });

  console.log(
    `🔍 Kiểm tra HTML drift trên ${sample.length} ID mẫu (rate ~1 req/${DELAY_MS / 1000}s)...\n`
  );

  const reports: PageReport[] = [];
  for (let i = 0; i < sample.length; i++) {
    const rep = await inspect(http, sample[i]);
    reports.push(rep);

    if (rep.fetchError) {
      console.log(`❓ ${rep.id}  fetch lỗi: ${rep.fetchError}`);
    } else if (rep.ok && rep.failedChecks.length === 0 && rep.missingLabels.length === 0) {
      console.log(`✅ ${rep.id}  form khớp hoàn toàn`);
    } else {
      console.log(`⚠️  ${rep.id}  có sai khác:`);
      for (const f of rep.failedChecks) console.log(`      - ${f}`);
      if (rep.missingLabels.length)
        console.log(`      - label thiếu: ${rep.missingLabels.join(", ")}`);
      if (rep.djsonHasLatLon === false)
        console.log(`      - [warn] djson thiếu ship_lat/ship_lon dạng số`);
    }

    if (i < sample.length - 1) await sleep(DELAY_MS);
  }

  const fetched = reports.filter((r) => !r.fetchError);
  const brokenCritical = fetched.filter((r) => !r.ok);
  const labelDrift = fetched.filter((r) => r.missingLabels.length > 0);

  console.log("\n──────── KẾT LUẬN ────────");
  if (fetched.length === 0) {
    console.log("❓ Không fetch được trang nào (mạng/bị chặn). Không kết luận được.");
    process.exit(2);
  }
  if (brokenCritical.length > 0) {
    console.log(
      `🔴 FORM ĐÃ ĐỔI — ${brokenCritical.length}/${fetched.length} trang mất selector critical. Mapper sẽ hỏng. Cần cập nhật VesselFinderHtmlMapper.`
    );
    process.exit(1);
  }
  if (labelDrift.length > 0) {
    console.log(
      `🟡 Selector chính còn nguyên nhưng ${labelDrift.length}/${fetched.length} trang thiếu vài label. Có thể VF đổi tên nhãn -> vài field sẽ null. Kiểm tra thủ công.`
    );
    process.exit(0);
  }
  console.log(`🟢 Form ổn — tất cả ${fetched.length} trang khớp selector mapper.`);
  process.exit(0);
}

void main();
